import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function serviceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;

  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
      if (Array.isArray(parsed)) {
        const match = parsed.find((item) =>
          item?.name === "service_role" ||
          item?.name === "service_role_key" ||
          item?.type === "service_role"
        );
        if (match?.value) return match.value;
        if (match?.api_key) return match.api_key;
      }
      if (parsed && typeof parsed === "object") {
        const value = parsed.service_role || parsed.service_role_key ||
          parsed.SUPABASE_SERVICE_ROLE_KEY || parsed.secret_key;
        if (typeof value === "string" && value.length > 20) return value;
      }
    } catch {
      // Fall through to the configuration error below.
    }
  }
  throw new Error("Supabase service key is not configured.");
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const url = Deno.env.get("SUPABASE_URL");
if (!url) throw new Error("SUPABASE_URL is not configured.");

const admin = createClient(url, serviceKey(), {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed." }, 405);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return respond({ error: "Authentication is required." }, 401);

    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user) return respond({ error: "Invalid or expired session." }, 401);
    const user = auth.user;

    const body = await req.json().catch(() => ({}));
    if (body?.action !== "submit") return respond({ error: "Unknown action." }, 400);

    const leaveType = String(body?.leave_type || "").trim().toLowerCase();
    const allowedTypes = ["annual", "sick", "unpaid", "maternity", "paternity", "compassionate", "study", "other"];
    if (!allowedTypes.includes(leaveType)) return respond({ error: "Select a valid leave type." }, 400);

    const startDate = body?.start_date;
    const endDate = body?.end_date;
    if (!isRealDate(startDate) || !isRealDate(endDate) || endDate < startDate) {
      return respond({ error: "Enter valid dates and ensure the end date is on or after the start date." }, 400);
    }

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 2000) {
      return respond({ error: "Provide a reason of no more than 2,000 characters." }, 400);
    }

    const { data: account, error: accountError } = await admin
      .from("personal_portal_accounts")
      .select("staff_id, account_status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (accountError) {
      console.error("Leave account lookup:", accountError);
      return respond({ error: "Unable to verify your employee account." }, 500);
    }
    if (!account || account.account_status !== "active") {
      return respond({ error: "Your personal portal account is unavailable or suspended." }, 403);
    }
    if (!account.staff_id) return respond({ error: "This account is not linked to an employee record." }, 403);

    const { data: conflicts, error: conflictError } = await admin
      .from("leave_requests")
      .select("id, start_date, end_date, status")
      .eq("staff_id", account.staff_id)
      .in("status", ["pending", "approved"])
      .lte("start_date", endDate)
      .gte("end_date", startDate)
      .limit(1);

    if (conflictError) {
      console.error("Leave overlap check:", conflictError);
      return respond({ error: "Unable to validate the requested leave dates." }, 500);
    }
    if (conflicts?.length) {
      return respond({ error: "These dates overlap an existing pending or approved leave request." }, 409);
    }

    const start = new Date(startDate + "T00:00:00.000Z");
    const end = new Date(endDate + "T00:00:00.000Z");
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;

    const { data: request, error: insertError } = await admin
      .from("leave_requests")
      .insert({
        staff_id: account.staff_id,
        leave_type: leaveType,
        start_date: startDate,
        end_date: endDate,
        days,
        reason,
        status: "pending",
        created_by: user.id,
      })
      .select("id, leave_type, start_date, end_date, days, status, created_at")
      .single();

    if (insertError) {
      console.error("Leave request insert:", insertError);
      return respond({ error: "Your leave request could not be submitted. Please try again." }, 500);
    }

    return respond({ success: true, request });
  } catch (error) {
    console.error("Personal leave function:", error);
    return respond({ error: "An unexpected server error occurred." }, 500);
  }
});
