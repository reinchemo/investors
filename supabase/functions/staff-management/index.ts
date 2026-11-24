import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return reply({ error: "Sign in is required." }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = authHeader.replace(/^Bearer\s+/i, "");

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return reply({ error: "Your session is invalid. Sign in again." }, 401);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid request." }, 400);
    const action = String(body.action || "");

    const { data: roleRows, error: roleError } = await admin
      .from("user_roles").select("roles!inner(is_full_admin)").eq("user_id", authData.user.id);
    if (roleError) throw roleError;
    const isFullAdmin = (roleRows || []).some((row: any) => {
      const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
      return role?.is_full_admin === true;
    });
    if (!isFullAdmin) return reply({ error: "Full Administrator permission is required." }, 403);

    if (action === "list_staff") {
      const { data, error } = await admin
        .from("staff")
        .select("id,employee_number,full_name,role,phone,email,status,start_date,end_date,annual_leave_days,location_id,address,payment_method,salary")
        .is("deleted_at", null)
        .order("full_name");
      if (error) throw error;

      const ids = (data || []).map((x: any) => x.id);
      const { data: links, error: linkError } = ids.length
        ? await admin.from("personal_portal_accounts").select("staff_id,account_status").in("staff_id", ids)
        : { data: [], error: null };
      if (linkError) throw linkError;
      const linked = new Map((links || []).map((x: any) => [x.staff_id, x.account_status]));
      return reply({
        success: true,
        staff: (data || []).map((x: any) => ({
          ...x,
          portal_account_status: linked.get(x.id) || null,
        })),
      });
    }

    if (action === "create_staff") {
      const fullName = String(body.full_name || "").trim();
      const employeeNumber = String(body.employee_number || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const role = String(body.role || "Employee").trim();
      const phone = String(body.phone || "").trim();
      if (!fullName || fullName.length > 150 || !employeeNumber || employeeNumber.length > 40) {
        return reply({ error: "Full name and employee number are required." }, 400);
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply({ error: "Enter a valid email address." }, 400);

      const { data, error } = await admin.from("staff").insert({
        full_name: fullName,
        employee_number: employeeNumber,
        email: email || null,
        role: role || "Employee",
        phone: phone || null,
        status: "active",
        start_date: body.start_date || new Date().toISOString().slice(0, 10),
        notes: "Created through STARLINK Staff Management",
      }).select("id,employee_number,full_name,email,status").single();

      if (error) {
        if (error.code === "23505") return reply({ error: "That employee number already exists." }, 409);
        throw error;
      }
      return reply({ success: true, employee: data });
    }

    if (action === "update_staff") {
      const staffId = Number(body.staff_id);
      const fullName = String(body.full_name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const phone = String(body.phone || "").trim();
      const role = String(body.role || "Employee").trim();
      const status = String(body.status || "active").toLowerCase();
      const startDate = body.start_date ? String(body.start_date) : null;
      const salaryProvided = body.salary !== undefined && body.salary !== null && body.salary !== "";
      const newSalary = salaryProvided ? Number(body.salary) : null;
      const salaryEffectiveFrom = body.salary_effective_from ? String(body.salary_effective_from) : new Date().toISOString().slice(0, 10);
      const salaryReason = String(body.salary_reason || "").trim();
      if (salaryProvided && (!Number.isFinite(newSalary) || newSalary < 0)) return reply({ error: "Enter a valid non-negative monthly salary." }, 400);
      if (!Number.isSafeInteger(staffId) || staffId <= 0) return reply({ error: "Select a valid employee." }, 400);
      if (!fullName || fullName.length > 150) return reply({ error: "Enter the employee's full name (maximum 150 characters)." }, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply({ error: "Enter a valid email address." }, 400);
      if (!["active", "inactive"].includes(status)) return reply({ error: "Choose active or inactive employment status." }, 400);
      const { data: current, error: currentError } = await admin.from("staff")
        .select("id,status,deleted_at,salary").eq("id", staffId).is("deleted_at", null).maybeSingle();
      if (currentError) throw currentError;
      if (!current) return reply({ error: "Employee record not found." }, 404);
      const update: Record<string, unknown> = {
        full_name: fullName, email: email || null, phone: phone || null, role: role || "Employee",
        status, start_date: startDate,
        payment_method: body.payment_method ? String(body.payment_method) : null,
        address: body.address ? String(body.address).trim().slice(0, 250) : null,
        updated_at: new Date().toISOString(), updated_by: authData.user.id,
      };
      const salaryChanged = salaryProvided && Number(current.salary || 0) !== newSalary;
      if (salaryChanged && (!salaryReason || salaryReason.length > 250)) {
        return reply({ error: "A short reason is required when changing an employee's salary." }, 400);
      }
      if (salaryChanged && !/^\d{4}-\d{2}-\d{2}$/.test(salaryEffectiveFrom)) {
        return reply({ error: "Choose a valid salary effective date." }, 400);
      }
      if (salaryChanged) update.salary = newSalary;
      if (status === "inactive" && current.status === "active") update.end_date = new Date().toISOString().slice(0, 10);
      if (status === "active" && current.status !== "active") update.end_date = null;
      const { data, error } = await admin.from("staff").update(update).eq("id", staffId)
        .select("id,employee_number,full_name,email,phone,role,status,start_date,end_date").single();
      if (error) throw error;
      if (salaryChanged) {
        const { error: historyError } = await admin.from("staff_salary_history").insert({
          staff_id: staffId,
          monthly_salary: newSalary,
          effective_from: salaryEffectiveFrom,
          reason: salaryReason,
          created_by: authData.user.id,
        });
        if (historyError) {
          await admin.from("staff").update({ salary: current.salary }).eq("id", staffId);
          throw new Error("Salary history could not be saved; the previous salary was restored. " + historyError.message);
        }
      }
      return reply({ success: true, employee: data, message: salaryChanged ? "Employee record and salary history updated." : "Employee record updated." });
    }

    if (action === "invite_staff") {
      const staffId = Number(body.staff_id);
      const email = String(body.email || "").trim().toLowerCase();
      if (!Number.isSafeInteger(staffId) || staffId <= 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply({ error: "Select an employee and enter a valid email address." }, 400);
      }

      const { data: staff, error: staffError } = await admin
        .from("staff")
        .select("id,full_name,employee_number,email,status")
        .eq("id", staffId)
        .is("deleted_at", null)
        .single();
      if (staffError || !staff) return reply({ error: "Employee record not found." }, 404);
      if (staff.status !== "active") return reply({ error: "Only active employees can receive portal invitations." }, 400);

      const { data: existingLink, error: existingError } = await admin
        .from("personal_portal_accounts")
        .select("id")
        .eq("staff_id", staffId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existingLink) return reply({ error: "This employee already has a linked portal account." }, 409);

      const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: "http://127.0.0.1:5500/portal/dashboard.html"
      });
      if (inviteError || !inviteData.user) {
        return reply({ error: inviteError?.message || "Unable to send the invitation." }, 400);
      }

      const { error: updateError } = await admin.from("staff").update({ email }).eq("id", staffId);
      if (updateError) throw updateError;

      const { error: linkError } = await admin.from("personal_portal_accounts").insert({
        user_id: inviteData.user.id,
        staff_id: staffId,
        account_status: "active",
      });
      if (linkError) {
        console.error("Portal account link failed after invitation", linkError);
        return reply({ error: "Invitation was created, but linking the portal account failed. Contact an administrator before inviting again." }, 500);
      }

      return reply({ success: true, message: "Portal invitation sent and employee account linked.", email });
    }

    return reply({ error: "Unsupported staff action." }, 400);
  } catch (error) {
    console.error("staff-management error", error);
    return reply({ error: error instanceof Error ? error.message : "Unexpected server error." }, 500);
  }
});