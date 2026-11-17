
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

function getServiceKey(): string {
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");

  if (!secretKeysJson) {
    throw new Error("SUPABASE_SECRET_KEYS is missing.");
  }

  const parsedKeys = JSON.parse(secretKeysJson);
  const serviceKey = parsedKeys["default"];

  if (!serviceKey) {
    throw new Error("Default Supabase secret key not found.");
  }

  return serviceKey;
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  getServiceKey(),
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

const allowedOrigins = (
  Deno.env.get("ALLOWED_ORIGINS") ??
  "http://localhost:5500,http://127.0.0.1:5500"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsHeaders(origin: string | null) {
  const allowedOrigin =
    origin && allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function response(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });
}

function validId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigins.includes(origin)) {
      return response({ error: "Origin not allowed." }, 403, headers);
    }

    return new Response("ok", { headers });
  }

  if (req.method !== "POST") {
    return response({ error: "Method not allowed." }, 405, headers);
  }

  if (origin && !allowedOrigins.includes(origin)) {
    return response({ error: "Origin not allowed." }, 403, headers);
  }

  try {
    // Require an authenticated administrator.
    const authorization = req.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return response({ error: "Authentication required." }, 401, headers);
    }

    const token = authorization.slice(7);

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    if (authError || !authData.user) {
      return response({ error: "Invalid authentication." }, 401, headers);
    }

    const requestingUserId = authData.user.id;

    // Check the actual database role.
    const { data: roleRows, error: roleError } =
      await supabaseAdmin
        .from("user_roles")
        .select("roles!inner(is_full_admin)")
        .eq("user_id", requestingUserId);

    if (roleError) {
      throw new Error("Could not verify administrator permissions.");
    }

    const isSuperAdmin = (roleRows ?? []).some((row: any) => {
      const role = Array.isArray(row.roles)
        ? row.roles[0]
        : row.roles;

      return role?.is_full_admin === true;
    });

    if (!isSuperAdmin) {
      return response(
        { error: "Super Administrator permission required." },
        403,
        headers,
      );
    }

    const body = await req.json();

    const {
      action,
      user_id,
      staff_id,
      investor_id,
    } = body;

    if (
      typeof user_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)
    ) {
      return response({ error: "Valid user_id is required." }, 400, headers);
    }

    // Verify that the target authentication account exists.
    const { data: targetUser, error: targetUserError } =
      await supabaseAdmin.auth.admin.getUserById(user_id);

    if (targetUserError || !targetUser.user) {
      return response({ error: "Target account not found." }, 404, headers);
    }

    // Suspend or reactivate an existing portal account.
    if (action === "suspend" || action === "activate") {
      const { data: existing, error: existingError } =
        await supabaseAdmin
          .from("personal_portal_accounts")
          .select("id")
          .eq("user_id", user_id)
          .maybeSingle();

      if (existingError) throw existingError;

      if (!existing) {
        return response(
          { error: "Personal portal account not found." },
          404,
          headers,
        );
      }

      const newStatus = action === "suspend" ? "suspended" : "active";

      const { error: updateError } = await supabaseAdmin
        .from("personal_portal_accounts")
        .update({
          account_status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user_id);

      if (updateError) throw updateError;

      return response({
        success: true,
        message: `Personal portal account ${newStatus}.`,
      }, 200, headers);
    }

    // Link an employee and/or investor record.
    if (action !== "link") {
      return response({ error: "Unsupported action." }, 400, headers);
    }

    if (staff_id !== undefined && staff_id !== null && !validId(staff_id)) {
      return response({ error: "Invalid staff_id." }, 400, headers);
    }

    if (
      investor_id !== undefined &&
      investor_id !== null &&
      !validId(investor_id)
    ) {
      return response({ error: "Invalid investor_id." }, 400, headers);
    }

    if (
      (staff_id === undefined || staff_id === null) &&
      (investor_id === undefined || investor_id === null)
    ) {
      return response(
        { error: "Provide a staff_id, investor_id, or both." },
        400,
        headers,
      );
    }

    // Read the existing links so that adding an investor
    // does not remove an existing employee link, and vice versa.
    const { data: existingAccount, error: accountError } =
      await supabaseAdmin
        .from("personal_portal_accounts")
        .select("*")
        .eq("user_id", user_id)
        .maybeSingle();

    if (accountError) throw accountError;

    const finalStaffId =
      staff_id === undefined
        ? existingAccount?.staff_id ?? null
        : staff_id;

    const finalInvestorId =
      investor_id === undefined
        ? existingAccount?.investor_id ?? null
        : investor_id;

    // Verify the employee record exists and is not deleted.
    if (finalStaffId !== null) {
      const { data: staffRecord, error: staffError } =
        await supabaseAdmin
          .from("staff")
          .select("id")
          .eq("id", finalStaffId)
          .is("deleted_at", null)
          .maybeSingle();

      if (staffError) throw staffError;

      if (!staffRecord) {
        return response(
          { error: "Active staff record not found." },
          404,
          headers,
        );
      }
    }

    // Verify the investor record exists and is not deleted.
    if (finalInvestorId !== null) {
      const { data: investorRecord, error: investorError } =
        await supabaseAdmin
          .from("investors")
          .select("id")
          .eq("id", finalInvestorId)
          .is("deleted_at", null)
          .maybeSingle();

      if (investorError) throw investorError;

      if (!investorRecord) {
        return response(
          { error: "Active investor record not found." },
          404,
          headers,
        );
      }
    }

    const accountData = {
      user_id,
      staff_id: finalStaffId,
      investor_id: finalInvestorId,
      account_status: "active",
      updated_at: new Date().toISOString(),
    };

    let saveError;

    if (existingAccount) {
      const { error } = await supabaseAdmin
        .from("personal_portal_accounts")
        .update(accountData)
        .eq("user_id", user_id);

      saveError = error;
    } else {
      const { error } = await supabaseAdmin
        .from("personal_portal_accounts")
        .insert(accountData);

      saveError = error;
    }

    if (saveError) {
      if (saveError.code === "23505") {
        return response(
          {
            error:
              "This staff or investor record is already linked to another account.",
          },
          409,
          headers,
        );
      }

      throw saveError;
    }

    return response({
      success: true,
      message: "Personal portal account linked successfully.",
      account: {
        user_id,
        staff_id: finalStaffId,
        investor_id: finalInvestorId,
        account_status: "active",
      },
    }, 200, headers);

  } catch (error) {
    console.error("Personal portal account error:", error);

    return response(
      { error: "The account operation could not be completed." },
      500,
      headers,
    );
  }
});
