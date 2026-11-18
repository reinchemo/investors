
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function kenyaDateTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const get = (key: string) => parts.find(p => p.type === key)!.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    timestamp: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return response({ error: "Method not allowed." }, 405);
  }

  try {
    const token = (req.headers.get("Authorization") || "")
      .replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return response({ error: "Authentication required." }, 401);
    }

    const { data: auth, error: authError } =
      await admin.auth.getUser(token);

    if (authError || !auth.user) {
      return response({ error: "Invalid session." }, 401);
    }

    const user = auth.user;

    const { data: account, error: accountError } = await admin
      .from("personal_portal_accounts")
      .select("staff_id, account_status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (accountError) throw accountError;

    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return response({ error: "Invalid request." }, 400);
    const action = body.action;
    const staffId = account?.staff_id ?? null;
    const employeeActions = ["my_attendance", "check_in", "check_out", "submit_correction"];

    // Employee actions require an active employee-linked portal account.
    // Management actions are authorised separately through role permissions.
    if (employeeActions.includes(action) &&
        (!account || account.account_status !== "active" || !staffId)) {
      return response({ error: "An active employee-linked portal account is required for this action." }, 403);
    }

    const now = kenyaDateTime();

    // A user-scoped client preserves auth.uid() for permission checks.
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // EMPLOYEE: VIEW OWN ATTENDANCE
    if (action === "my_attendance") {
      const { data, error } = await admin
        .from("attendance")
        .select("id, date, check_in, check_out, status, notes, approval_notes, approved_at")
        .eq("staff_id", staffId)
        .order("date", { ascending: false })
        .limit(90);

      if (error) throw error;
      return response({ success: true, attendance: data });
    }

    // EMPLOYEE: CHECK IN
    if (action === "check_in") {
      const { hour, minute } = now;

      if (hour === 23 && minute >= 59) {
        return response({
          error: "The attendance cut-off has passed. Submit a correction request."
        }, 400);
      }

      const { data: existing, error: lookupError } = await admin
        .from("attendance")
        .select("id, check_in")
        .eq("staff_id", staffId)
        .eq("date", now.date)
        .maybeSingle();

      if (lookupError) throw lookupError;

      if (existing) {
        return response({ error: "Attendance already exists for today." }, 409);
      }

      const { data, error } = await admin
        .from("attendance")
        .insert({
          staff_id: staffId,
          date: now.date,
          check_in: now.timestamp,
          status: "pending",
          submitted_at: now.timestamp,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") return response({ error: "Attendance already exists for today." }, 409);
        throw error;
      }

      const { error: auditError } = await admin.from("attendance_audit_log").insert({
        attendance_id: data.id,
        actor_id: user.id,
        action: "check_in",
        new_values: data,
        details: "Employee check-in",
      });
      if (auditError) {
        console.error("Check-in audit failure", auditError);
        return response({ error: "Check-in saved but audit logging failed. Contact an administrator before retrying.", attendance: data }, 500);
      }

      return response({ success: true, attendance: data });
    }

    // EMPLOYEE: CHECK OUT
    if (action === "check_out") {
      const { hour, minute } = now;

      if (hour === 23 && minute >= 59) {
        return response({
          error: "The attendance cut-off has passed. Submit a correction request."
        }, 400);
      }

      const { data: record, error: lookupError } = await admin
        .from("attendance")
        .select("*")
        .eq("staff_id", staffId)
        .eq("date", now.date)
        .maybeSingle();

      if (lookupError) throw lookupError;

      if (!record || !record.check_in) {
        return response({ error: "Check in before checking out." }, 400);
      }

      if (record.check_out) {
        return response({ error: "You have already checked out." }, 409);
      }

      const { data, error } = await admin
        .from("attendance")
        .update({ check_out: now.timestamp })
        .eq("id", record.id)
        .is("check_out", null)
        .select()
        .single();

      if (error) {
        if (error.code === "PGRST116") return response({ error: "You have already checked out." }, 409);
        throw error;
      }

      const { error: auditError } = await admin.from("attendance_audit_log").insert({
        attendance_id: data.id,
        actor_id: user.id,
        action: "check_out",
        old_values: { check_out: null },
        new_values: { check_out: data.check_out },
        details: "Employee check-out",
      });
      if (auditError) {
        console.error("Check-out audit failure", auditError);
        return response({ error: "Check-out saved but audit logging failed. Contact an administrator before retrying.", attendance: data }, 500);
      }

      return response({ success: true, attendance: data });
    }

    // EMPLOYEE: REQUEST ATTENDANCE CORRECTION
    if (action === "submit_correction") {
      const attendanceId = Number(body.attendance_id);
      const reason = String(body.reason || "").trim();

      if (!Number.isSafeInteger(attendanceId) ||
          attendanceId <= 0 || !reason || reason.length > 2000) {
        return response({ error: "Attendance ID and reason are required." }, 400);
      }

      const parseTime = (value: unknown) => {
        if (value === null || value === undefined || value === "") return null;
        if (typeof value !== "string") throw new Error("INVALID_CORRECTION_TIME");

        // datetime-local returns YYYY-MM-DDTHH:mm with no timezone.
        // Treat that value as Kenya local time (UTC+03:00).
        const localMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
        if (localMatch) {
          const [, year, month, day, hour, minute] = localMatch;
          const localIso = `${year}-${month}-${day}T${hour}:${minute}:00+03:00`;
          const parsedLocal = Date.parse(localIso);
          if (!Number.isFinite(parsedLocal)) throw new Error("INVALID_CORRECTION_TIME");
          return new Date(parsedLocal).toISOString();
        }

        // Also accept an explicit timezone-aware ISO timestamp.
        const parsed = Date.parse(value);
        if (!Number.isFinite(parsed) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
          throw new Error("INVALID_CORRECTION_TIME");
        }
        return new Date(parsed).toISOString();
      };
      let requestedIn: string | null;
      let requestedOut: string | null;
      try { requestedIn = parseTime(body.requested_check_in); requestedOut = parseTime(body.requested_check_out); }
      catch { return response({ error: "Correction times must include a valid timezone." }, 400); }
      if (!requestedIn && !requestedOut) return response({ error: "Provide at least one corrected time." }, 400);
      if (requestedIn && requestedOut && requestedOut <= requestedIn) return response({ error: "Check-out must be after check-in." }, 400);

      const { data: record, error: lookupError } = await admin
        .from("attendance")
        .select("id, staff_id, date")
        .eq("id", attendanceId)
        .eq("staff_id", staffId)
        .maybeSingle();

      if (lookupError) throw lookupError;
      if (!record) return response({ error: "Attendance record not found." }, 404);
      const kenyaDate = (timestamp: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
      if ((requestedIn && kenyaDate(requestedIn) !== record.date) || (requestedOut && kenyaDate(requestedOut) !== record.date)) return response({ error: "Corrected times must fall on the attendance date (Kenya time)." }, 400);

      const { data, error } = await admin
        .from("attendance_correction_requests")
        .insert({
          attendance_id: attendanceId,
          staff_id: staffId,
          requested_by: user.id,
          requested_check_in: requestedIn,
          requested_check_out: requestedOut,
          reason,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          return response({
            error: "A pending correction already exists for this attendance record."
          }, 409);
        }
        throw error;
      }

      return response({ success: true, correction: data });
    }

    // MANAGEMENT: TEAM ATTENDANCE
    if (action === "team_attendance") {
      const { data: permitted, error: permissionError } =
        await userClient.rpc("portal_management_can_view", {
          p_module: "Attendance",
        });

      if (permissionError) throw permissionError;
      if (!permitted) return response({ error: "Permission denied." }, 403);

      const requestedDate = String(body.date || now.date);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return response({ error: "Invalid date." }, 400);
      }

      const { data, error } = await admin
        .from("attendance")
        .select("id, staff_id, date, check_in, check_out, status, notes, approved_at, approval_notes")
        .eq("date", requestedDate)
        .order("staff_id");

      if (error) throw error;
      const ids = [...new Set((data || []).map((r: any) => r.staff_id).filter(Boolean))];
      const { data: staffRows, error: staffError } = ids.length
        ? await admin.from("staff").select("id, employee_number, full_name, role").in("id", ids)
        : { data: [], error: null };
      if (staffError) throw staffError;
      const staffById = new Map((staffRows || []).map((x: any) => [x.id, x]));
      const enriched = (data || []).map((r: any) => ({ ...r, staff: staffById.get(r.staff_id) || null }));
      return response({ success: true, attendance: enriched });
    }

    // MANAGEMENT: VIEW CORRECTION REQUESTS
    if (action === "pending_corrections") {
      const { data: permitted, error: permissionError } =
        await userClient.rpc("portal_management_can_view", {
          p_module: "Attendance",
        });

      if (permissionError) throw permissionError;
      if (!permitted) return response({ error: "Permission denied." }, 403);

      const { data, error } = await admin
        .from("attendance_correction_requests")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true });

      if (error) throw error;
      const ids = [...new Set((data || []).map((r: any) => r.staff_id).filter(Boolean))];
      const { data: staffRows, error: staffError } = ids.length
        ? await admin.from("staff").select("id, employee_number, full_name, role").in("id", ids)
        : { data: [], error: null };
      if (staffError) throw staffError;
      const staffById = new Map((staffRows || []).map((x: any) => [x.id, x]));
      const enriched = (data || []).map((r: any) => ({ ...r, staff: staffById.get(r.staff_id) || null }));
      return response({ success: true, corrections: enriched });
    }

    // MANAGEMENT: REVIEW AN ORDINARY ATTENDANCE RECORD.
    if (action === "review_attendance") {
      const attendanceId = Number(body.attendance_id);
      const decision = String(body.decision || "");
      const reviewNotes = String(body.review_notes || "").trim();
      if (!Number.isSafeInteger(attendanceId) || attendanceId <= 0 ||
          !["approved", "rejected"].includes(decision) || reviewNotes.length > 2000) {
        return response({ error: "Invalid attendance review details." }, 400);
      }
      const { data, error } = await userClient.rpc("review_attendance_record", {
        p_attendance_id: attendanceId,
        p_decision: decision,
        p_review_notes: reviewNotes || null,
      });
      if (error) {
        const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "40001" ? 409 : 400;
        return response({ error: error.message || "Attendance review failed." }, status);
      }

      // Notify the employee after the transactional review and audit have succeeded.
      const { data: reviewedRecord, error: recordError } = await admin
        .from("attendance")
        .select("id, staff_id, date, status, approval_notes")
        .eq("id", attendanceId)
        .single();
      if (recordError) throw recordError;

      const { data: employeeAccount, error: employeeAccountError } = await admin
        .from("personal_portal_accounts")
        .select("user_id")
        .eq("staff_id", reviewedRecord.staff_id)
        .eq("account_status", "active")
        .maybeSingle();
      if (employeeAccountError) throw employeeAccountError;

      if (employeeAccount?.user_id) {
        const rejected = decision === "rejected";
        const title = rejected ? "Attendance rejected" : "Attendance approved";
        const bodyText = rejected
          ? `Your attendance for ${reviewedRecord.date} was rejected. Reason: ${reviewedRecord.approval_notes || reviewNotes}`
          : `Your attendance for ${reviewedRecord.date} has been approved.`;
        const { error: notificationError } = await admin.from("notifications").insert({
          kind: rejected ? "attendance_rejected" : "attendance_approved",
          severity: rejected ? "warning" : "success",
          title,
          body: bodyText,
          link_view: "attendance",
          link_ref: String(attendanceId),
          dedupe_key: `attendance-review-${attendanceId}-${decision}`,
          recipient_user_id: employeeAccount.user_id,
          created_by: user.id,
          metadata: {
            attendance_id: attendanceId,
            attendance_date: reviewedRecord.date,
            decision,
            rejection_reason: rejected ? reviewedRecord.approval_notes : null,
          },
        });
        if (notificationError) {
          console.error("Attendance notification insert failed", notificationError);
          return response({
            success: true,
            notification_sent: false,
            warning: "Attendance was reviewed and audited, but the employee notification could not be saved.",
            review: data,
          });
        }
      }

      return response({ ...(data || { success: true }), notification_sent: !!employeeAccount?.user_id });
    }

    // MANAGEMENT: REVIEW A CORRECTION. The database RPC performs
    // permission validation, row locking, update and audit insert atomically.
    if (action === "review_correction") {
      const requestId = Number(body.request_id);
      const decision = String(body.decision || "");
      const reviewNotes = String(body.review_notes || "").trim();
      if (!Number.isSafeInteger(requestId) || requestId <= 0 ||
          !["approved", "rejected"].includes(decision) || reviewNotes.length > 2000) {
        return response({ error: "Invalid correction review details." }, 400);
      }
      const { data, error } = await userClient.rpc("review_attendance_correction", {
        p_request_id: requestId,
        p_decision: decision,
        p_review_notes: reviewNotes || null,
      });
      if (error) {
        const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "40001" ? 409 : 400;
        return response({ error: error.message || "Correction review failed." }, status);
      }
      return response(data || { success: true });
    }

    return response({ error: "Unknown attendance action." }, 400);

  } catch (error) {
    console.error("Attendance function error:", error);
    return response({ error: "Unable to process attendance request." }, 500);
  }
});
