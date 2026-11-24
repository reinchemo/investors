
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getServiceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;

  const secrets = Deno.env.get("SUPABASE_SECRET_KEYS");

  if (secrets) {
    try {
      const parsed = JSON.parse(secrets);

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

      if (typeof parsed === "object" && parsed !== null) {
        const candidates = [
          parsed.service_role,
          parsed.service_role_key,
          parsed.SUPABASE_SERVICE_ROLE_KEY,
          parsed.secret_key,
        ];

        const match = candidates.find(
          (value) => typeof value === "string" && value.length > 20
        );

        if (match) return match;
      }
    } catch {
      // The secret may not be JSON.
    }
  }

  throw new Error("Supabase service key is not configured.");
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL is not configured.");
}

const SERVICE_KEY = getServiceKey();

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  try {
    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return jsonResponse({ error: "Authentication is required." }, 401);
    }

    // Verify the signed-in user.
    const { data: authData, error: authError } =
      await admin.auth.getUser(token);

    if (authError || !authData.user) {
      return jsonResponse({ error: "Invalid or expired session." }, 401);
    }

    const user = authData.user;

    // Only active personal portal accounts can use this function.
    const { data: account, error: accountError } = await admin
      .from("personal_portal_accounts")
      .select("id, staff_id, investor_id, funder_id, account_status, created_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (accountError) {
      console.error("Portal account lookup:", accountError);
      return jsonResponse({ error: "Unable to verify portal access." }, 500);
    }

    if (!account || account.account_status !== "active") {
      return jsonResponse(
        { error: "Your personal portal account is not active." },
        403
      );
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    // ==========================================
    // PORTAL ACCESS CLASSIFICATION
    // ==========================================

    if (action === "portal_access") {
      if (!account.staff_id && !account.investor_id && !account.funder_id) {
        return jsonResponse({ error: "Your account has no employee or investor classification." }, 403);
      }
      return jsonResponse({
        success: true,
        account: {
          staff_id: account.staff_id,
          investor_id: account.investor_id,
          funder_id: account.funder_id,
          account_status: account.account_status,
        },
      });
    }

    // ==========================================
    // EMPLOYEE DASHBOARD SUMMARY
    // ==========================================

    if (action === "employee_dashboard") {
      if (!account.staff_id) {
        return jsonResponse({ success: true, staff: null, attendance: [], tasks: [], leave_requests: [] });
      }

      const [staffResult, attendanceResult, tasksResult, leaveResult] = await Promise.all([
        admin.from("staff")
          .select("id, employee_number, full_name, role, phone, email, status, start_date, annual_leave_days")
          .eq("id", account.staff_id)
          .maybeSingle(),
        admin.from("attendance")
          .select("id, date, check_in, check_out, notes")
          .eq("staff_id", account.staff_id)
          .order("date", { ascending: false })
          .limit(10),
        admin.from("task_assignments")
          .select("id,assignment_state,progress_pct,assigned_at,tasks(id,title,priority,status,progress_pct,deadline,assignment_mode,service_status)")
          .eq("staff_id", account.staff_id)
          .order("assigned_at", { ascending: false })
          .limit(20),
        admin.from("leave_requests")
          .select("id, leave_type, start_date, end_date, days, status")
          .eq("staff_id", account.staff_id)
          .order("created_at", { ascending: false })
          .limit(15),
      ]);

      if (staffResult.error || attendanceResult.error || tasksResult.error || leaveResult.error) {
        console.error("Employee dashboard:", staffResult.error, attendanceResult.error, tasksResult.error, leaveResult.error);
        return jsonResponse({ error: "Unable to load your employee dashboard." }, 500);
      }

      return jsonResponse({
        success: true,
        staff: staffResult.data || null,
        attendance: attendanceResult.data || [],
        tasks: (tasksResult.data || []).map((assignment: any) => ({ ...assignment.tasks, assignment_id: assignment.id, assignment_state: assignment.assignment_state, assignment_progress_pct: assignment.progress_pct })).filter((task: any) => task && task.id),
        leave_requests: leaveResult.data || [],
      });
    }

    // ==========================================
    // INVESTOR DASHBOARD SUMMARY
    // ==========================================

    if (action === "investor_dashboard") {
      if (!account.investor_id) {
        if(!account.funder_id)return jsonResponse({ success: true, investor: null, investments: [], transactions: [] });
        const {data:funderProfile,error:funderError}=await admin.from("funding_parties").select("id,legal_name,status,created_at").eq("id",account.funder_id).maybeSingle();
        if(funderError||!funderProfile)return jsonResponse({error:"Your funding profile is not available."},404);
        return jsonResponse({success:true,investor:{id:null,name:funderProfile.legal_name,investor_number:"SHORT-TERM",equity:0,status:funderProfile.status,joined_date:funderProfile.created_at},investments:[],transactions:[],funder_only:true});
      }

      const investorId = Number(account.investor_id);
      const [investorResult, investmentsResult, transactionsResult] = await Promise.all([
        admin.from("investors")
          .select("id, name, investor_number, equity, status, joined_date")
          .eq("id", investorId)
          .is("deleted_at", null)
          .maybeSingle(),
        admin.from("investments")
          .select("id, date, amount, type, reference")
          .eq("investor_id", investorId)
          .is("deleted_at", null)
          .order("date", { ascending: false })
          .limit(10),
        admin.from("share_transactions")
          .select("id, date, action, delta, equity_after, reference")
          .eq("investor_id", investorId)
          .order("date", { ascending: false })
          .limit(10),
      ]);

      if (investorResult.error || investmentsResult.error || transactionsResult.error) {
        console.error("Investor dashboard:", investorResult.error, investmentsResult.error, transactionsResult.error);
        return jsonResponse({ error: "Unable to load your investor dashboard." }, 500);
      }

      if (account.investor_id && !investorResult.data) {
        return jsonResponse({ error: "Your investor record is not available." }, 404);
      }

      return jsonResponse({
        success: true,
        investor: investorResult.data || null,
        investments: investmentsResult.data || [],
        transactions: transactionsResult.data || [],
      });
    }

    // ==========================================
    // PERSONAL PROFILE
    // ==========================================

    if (action === "profile") {
      const [staffResult, investorResult] = await Promise.all([
        account.staff_id
          ? admin.from("staff")
              .select("id, employee_number, full_name, role, phone, email, national_id, address, salary, payment_method, payment_details, start_date, end_date, status, annual_leave_days, location_id, notes")
              .eq("id", account.staff_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        account.investor_id
          ? admin.from("investors")
              .select("id, name, investor_number, phone, email, id_number, address, equity, status, joined_date")
              .eq("id", account.investor_id)
              .is("deleted_at", null)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (staffResult.error || investorResult.error) {
        console.error("Personal profile:", staffResult.error, investorResult.error);
        return jsonResponse({ error: "Unable to load your personal profile." }, 500);
      }

      return jsonResponse({
        success: true,
        account: {
          account_status: account.account_status,
          created_at: account.created_at || null,
        },
        user: {
          id: user.id,
          email: user.email || null,
          full_name: user.user_metadata?.full_name || null,
        },
        staff: staffResult.data || null,
        investor: investorResult.data || null,
      });
    }

    // ====================
    // EMPLOYEE EARNINGS PERIOD (PERSONAL ONLY)
    if (action === "employee_earnings") {
      if (!account.staff_id) return jsonResponse({ success: true, staff: null, attendance: [], leave_requests: [], overtime: [] });
      const period = String(body?.period || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return jsonResponse({ error: "A valid YYYY-MM payroll period is required." }, 400);
      const [year, month] = period.split("-").map(Number);
      const start = `${period}-01`;
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      const [staffResult, attendanceResult, leaveResult, overtimeResult] = await Promise.all([
        admin.from("staff").select("id, employee_number, full_name, salary, start_date, end_date, status, annual_leave_days").eq("id", account.staff_id).maybeSingle(),
        admin.from("attendance").select("id, date, check_in, check_out, status, approval_notes").eq("staff_id", account.staff_id).gte("date", start).lte("date", end).order("date", { ascending: false }),
        admin.from("leave_requests").select("id, leave_type, start_date, end_date, days, status, notes, rejection_reason").eq("staff_id", account.staff_id).eq("status", "approved").lte("start_date", end).gte("end_date", start).order("start_date", { ascending: false }),
        admin.from("overtime_entries").select("id, period, hours, rate_per_hour, amount, status, reason").eq("staff_id", account.staff_id).eq("period", period).order("created_at", { ascending: false }),
      ]);
      if (staffResult.error || attendanceResult.error || leaveResult.error || overtimeResult.error) {
        console.error("Employee earnings:", staffResult.error, attendanceResult.error, leaveResult.error, overtimeResult.error);
        return jsonResponse({ error: "Unable to load your earnings records." }, 500);
      }
      return jsonResponse({ success: true, staff: staffResult.data || null, attendance: attendanceResult.data || [], leave_requests: leaveResult.data || [], overtime: overtimeResult.data || [] });
    }

    // EMPLOYEE OVERTIME SUBMISSION (STAFF ID IS ALWAYS DERIVED SERVER-SIDE)
    if (action === "submit_overtime") {
      if (!account.staff_id) {
        return jsonResponse({ error: "This account is not linked to an employee record." }, 403);
      }
      const period = String(body?.period || "").trim();
      const hours = Number(body?.hours);
      const reason = String(body?.reason || "").trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
        return jsonResponse({ error: "Select a valid payroll month." }, 400);
      }
      if (!Number.isFinite(hours) || hours < 0.25 || hours > 240) {
        return jsonResponse({ error: "Hours must be between 0.25 and 240." }, 400);
      }
      if (!reason || reason.length > 1200) {
        return jsonResponse({ error: "Enter a reason of no more than 1,200 characters." }, 400);
      }
      const { data: staff, error: staffError } = await admin
        .from("staff")
        .select("id, status")
        .eq("id", account.staff_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (staffError || !staff) {
        console.error("Overtime staff verification:", staffError);
        return jsonResponse({ error: "Unable to verify your employee record." }, 500);
      }
      if (String(staff.status || "").toLowerCase() !== "active") {
        return jsonResponse({ error: "Only active employees can submit overtime." }, 403);
      }
      // Rate is deliberately zero until an authorised reviewer sets it.
      // Never accept staff_id, rate_per_hour, amount or status from the browser.
      const { data: entry, error: insertError } = await admin
        .from("overtime_entries")
        .insert({
          staff_id: account.staff_id,
          period,
          hours,
          reason,
          rate_per_hour: 0,
          amount: null,
          status: "pending",
          created_by: user.id,
        })
        .select("id, period, hours, status, created_at")
        .single();
      if (insertError) {
        console.error("Overtime submission:", insertError);
        return jsonResponse({ error: "Unable to submit your overtime request." }, 500);
      }
      return jsonResponse({ success: true, overtime: entry });
    }

    // EMPLOYEE OVERTIME HISTORY (PERSONAL ONLY)
    if (action === "overtime_history") {
      if (!account.staff_id) return jsonResponse({ success: true, overtime: [], message: "This account has no employee classification." });
      const { data, error } = await admin.from("overtime_entries")
        .select("id, period, hours, rate_per_hour, amount, status, reason, notes, rejection_reason, created_at")
        .eq("staff_id", account.staff_id).order("created_at", { ascending: false }).limit(300);
      if (error) {
        console.error("Employee overtime:", error);
        return jsonResponse({ error: "Unable to load your overtime records." }, 500);
      }
      return jsonResponse({ success: true, overtime: data || [] });
    }

======================
    // EMPLOYEE LEAVE HISTORY
    // ==========================================

    if (action === "leave_history") {
      if (!account.staff_id) {
        return jsonResponse({
          success: true,
          staff: null,
          leave_requests: [],
          message: "This account has no employee classification.",
        });
      }

      const [staffResult, leaveResult] = await Promise.all([
        admin.from("staff")
          .select("id, annual_leave_days")
          .eq("id", account.staff_id)
          .maybeSingle(),
        admin.from("leave_requests")
          .select("id, leave_type, start_date, end_date, days, reason, status, notes, created_at")
          .eq("staff_id", account.staff_id)
          .order("created_at", { ascending: false }),
      ]);

      if (staffResult.error || leaveResult.error) {
        console.error("Employee leave history:", staffResult.error, leaveResult.error);
        return jsonResponse({ error: "Unable to load your leave records." }, 500);
      }

      return jsonResponse({
        success: true,
        staff: staffResult.data || null,
        leave_requests: leaveResult.data || [],
      });
    }

    // ==========================================
    // EMPLOYEE PAYSLIPS
    // ==========================================

    if (action === "payslips") {
      if (!account.staff_id) {
        return jsonResponse({
          success: true,
          payslips: [],
          message: "This account has no employee classification.",
        });
      }

      // Only payroll runs that have actually been posted are visible.
      const { data: runs, error: runsError } = await admin
        .from("payroll_runs")
        .select("id, period, run_date, status, posted_at")
        .not("posted_at", "is", null)
        .is("cancelled_at", null)
        .order("run_date", { ascending: false });

      if (runsError) {
        console.error("Payroll runs:", runsError);
        return jsonResponse({ error: "Unable to load payslips." }, 500);
      }

      const { data: employee, error: employeeError } = await admin
        .from("staff")
        .select("full_name, employee_number")
        .eq("id", account.staff_id)
        .maybeSingle();

      if (employeeError) {
        console.error("Payslip employee lookup:", employeeError);
        return jsonResponse({ error: "Unable to load employee details for your payslips." }, 500);
      }

      const runIds = (runs || []).map((run) => run.id);

      if (runIds.length === 0) {
        return jsonResponse({ success: true, payslips: [] });
      }

      const { data: items, error: itemsError } = await admin
        .from("payroll_items")
        .select("id, run_id, gross, deductions, net, notes, created_at, basic_pay, overtime_pay, allowances, other_deductions, employee_nssf, employee_shif, employee_housing_levy, paye, paid_days, salary_snapshot")
        .eq("staff_id", account.staff_id)
        .in("run_id", runIds)
        .order("created_at", { ascending: false });

      if (itemsError) {
        console.error("Payroll items:", itemsError);
        return jsonResponse({ error: "Unable to load payslips." }, 500);
      }

      const runMap = new Map(
        (runs || []).map((run) => [String(run.id), run])
      );

      const payslips = (items || []).map((item) => {
        const run = runMap.get(String(item.run_id));

        return {
          id: item.id,
          employee_name: employee?.full_name || null,
          employee_number: employee?.employee_number || null,
          period: run?.period || "Payroll period",
          run_date: run?.run_date || null,
          posted_at: run?.posted_at || null,
          gross: Number(item.gross || 0),
          deductions: Number(item.deductions || 0),
          net: Number(item.net || 0),
          basic_pay: Number(item.basic_pay || 0),
          overtime_pay: Number(item.overtime_pay || 0),
          allowances: Number(item.allowances || 0),
          other_deductions: Number(item.other_deductions || 0),
          employee_nssf: Number(item.employee_nssf || 0),
          employee_shif: Number(item.employee_shif || 0),
          employee_housing_levy: Number(item.employee_housing_levy || 0),
          paye: Number(item.paye || 0),
          paid_days: item.paid_days,
          salary_snapshot: item.salary_snapshot,
          notes: item.notes || null,
        };
      });

      return jsonResponse({ success: true, payslips });
    }

    // ==========================================
    // PERSONAL NOTIFICATIONS
    // ==========================================

    if (action === "notifications") {
      const { data, error } = await admin
        .from("notifications")
        .select(
          "id, kind, severity, title, body, link_view, link_ref, read_at, created_at"
        )
        .eq("recipient_user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) {
        console.error("Notifications:", error);
        return jsonResponse(
          { error: "Unable to load personal notifications." },
          500
        );
      }

      return jsonResponse({
        success: true,
        notifications: data || [],
      });
    }

    // ==========================================
    // MARK ONE PERSONAL NOTIFICATION AS READ
    // ==========================================

    if (action === "mark_notification_read") {
      const notificationId = Number(body?.notification_id);

      if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
        return jsonResponse({ error: "Invalid notification ID." }, 400);
      }

      const { data, error } = await admin
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", notificationId)
        .eq("recipient_user_id", user.id)
        .select("id, read_at")
        .maybeSingle();

      if (error) {
        console.error("Mark notification read:", error);
        return jsonResponse(
          { error: "Unable to update notification." },
          500
        );
      }

      if (!data) {
        return jsonResponse(
          { error: "Notification not found for this account." },
          404
        );
      }

      return jsonResponse({ success: true, notification: data });
    }

    // ==========================================
    // INVESTOR PROFILE, CONTRIBUTIONS AND SHARE HISTORY
    // ==========================================

    if (action === "investments") {
      if (!account.investor_id) {
        if (!account.funder_id) return jsonResponse({ success: true, investor: null, investments: [], transactions: [], message: "This account has no investor classification." });
        const {data:funderProfile,error:funderProfileError}=await admin.from("funding_parties").select("id,legal_name,status,created_at").eq("id",account.funder_id).maybeSingle();
        if(funderProfileError||!funderProfile)return jsonResponse({error:"Your funding profile is not available."},404);
        return jsonResponse({success:true,investor:{id:null,name:funderProfile.legal_name,investor_number:"SHORT-TERM",equity:0,status:funderProfile.status,joined_date:funderProfile.created_at},investments:[],transactions:[],funder_only:true});
      }

      const investorId = Number(account.investor_id);

      const [
        { data: investor, error: investorError },
        { data: investments, error: investmentsError },
        { data: transactions, error: transactionsError },
      ] = await Promise.all([
        admin
          .from("investors")
          .select("id, name, investor_number, equity, status, joined_date")
          .eq("id", investorId)
          .is("deleted_at", null)
          .maybeSingle(),
        admin
          .from("investments")
          .select("id, date, amount, type, reference, notes, fee")
          .eq("investor_id", investorId)
          .is("deleted_at", null)
          .order("date", { ascending: false })
          .limit(500),
        admin
          .from("share_transactions")
          .select("id, date, action, equity_before, equity_after, delta, pct_before, pct_after, reference, reason")
          .eq("investor_id", investorId)
          .order("date", { ascending: false })
          .limit(500),
      ]);

      if (investorError || investmentsError || transactionsError) {
        console.error("Investor portal records:", {
          investorError,
          investmentsError,
          transactionsError,
        });
        return jsonResponse(
          { error: "Unable to load your investment information." },
          500
        );
      }

      if (!investor) {
        return jsonResponse(
          { error: "Your investor record is not available." },
          404
        );
      }

      return jsonResponse({
        success: true,
        investor,
        investments: investments || [],
        transactions: transactions || [],
      });
    }

    // ==========================================
    // PRODUCT B — PERSONAL SHORT-TERM FUNDING
    // All rows are scoped to the investor linked to this verified portal session.
    // ==========================================
    if (action === "funding") {
      if (!account.investor_id && !account.funder_id) return jsonResponse({ success: true, funder: null, opportunities: [], commitments: [], message: "This account has no investor or funder classification." });
      const investorId = account.investor_id ? Number(account.investor_id) : null;
      const [{ data: investor, error: investorError }, { data: funder, error: funderError }] = await Promise.all([
        investorId ? admin.from("investors").select("id,name,email,phone").eq("id", investorId).is("deleted_at", null).maybeSingle() : Promise.resolve({data:null,error:null}),
        account.funder_id ? admin.from("funding_parties").select("id,legal_name,kyc_status,status,party_type").eq("id", account.funder_id).maybeSingle() : admin.from("funding_parties").select("id,legal_name,kyc_status,status,party_type").eq("investor_id", investorId).maybeSingle()
      ]);
      if (investorError || funderError) return jsonResponse({ error: "Unable to load your funding profile." }, 500);
      const today = new Date().toISOString().slice(0,10);
      const { data: opportunities, error: opportunitiesError } = await admin.from("funding_opportunities")
        .select("id,reference_code,title,description,funding_purpose,payment_instructions,target_amount,currency_code,minimum_commitment,maximum_commitment,proposed_return_rate,return_type,day_count_basis,term_days,opens_on,closes_on,eligibility,required_documents,early_settlement_allowed,terms_version")
        .eq("status","open").or("opens_on.is.null,opens_on.lte."+today).or("closes_on.is.null,closes_on.gte."+today).order("created_at",{ascending:false}).limit(100);
      if (opportunitiesError) return jsonResponse({ error: "Unable to load approved funding opportunities." }, 500);
      let commitments:any[] = [];
      let receipts:any[] = [];
      let settlements:any[] = [];
      if (funder) {
        const commitResult = await admin.from("funding_commitments").select("id,opportunity_id,principal_amount,currency_code,agreed_return_rate,term_days,maturity_date,status,agreement_reference,signed_at,terms_locked_at,terms_snapshot,return_type,day_count_basis,tax_rate_snapshot,created_at,accepted_at")
          .eq("funder_id",funder.id).order("created_at",{ascending:false}).limit(500);
        if (commitResult.error) return jsonResponse({ error: "Unable to load your funding commitments." }, 500);
        commitments = commitResult.data || [];
        const commitmentIds = commitments.map((item:any)=>item.id);
        if (commitmentIds.length) {
          const [receiptResult,settlementResult] = await Promise.all([
            admin.from("funding_receipts").select("id,commitment_id,amount,currency_code,received_on,payment_method,external_reference,verification_status,verified_at").in("commitment_id",commitmentIds).limit(1000),
            admin.from("funding_settlements").select("id,commitment_id,principal_paid,return_paid,paid_on,payment_reference,status").in("commitment_id",commitmentIds).order("created_at",{ascending:false}).limit(500)
          ]);
          if (receiptResult.error || settlementResult.error) return jsonResponse({ error: "Unable to load your funding statements." }, 500);
          receipts = receiptResult.data || []; settlements = settlementResult.data || [];
        }
      }
      const actual365=(term:number,basis:string)=>basis==="actual_360"?360:basis==="30_360"?360:365;
      const portfolio=commitments.map((c:any)=>{
        const snap=c.terms_snapshot||{};
        const verifiedReceipts=receipts.filter((r:any)=>r.commitment_id===c.id&&r.verification_status==="verified");
        const capitalReceived=verifiedReceipts.reduce((sum:number,r:any)=>sum+Number(r.amount||0),0);
        const paid=settlements.filter((x:any)=>x.commitment_id===c.id&&x.status==="paid");
        const principalRepaid=paid.reduce((sum:number,x:any)=>sum+Number(x.principal_paid||0),0);
        const returnAlreadyPaid=paid.reduce((sum:number,x:any)=>sum+Number(x.return_paid||0),0);
        const principal=Number(c.principal_amount||0);
        const rate=Number(snap.return_rate??c.agreed_return_rate??0);
        const term=Number(snap.term_days??c.term_days??0);
        const returnType=snap.return_type||c.return_type||"fixed_total_period";
        const basis=snap.day_count_basis||c.day_count_basis||"actual_365";
        const gross=returnType==="annualised_simple" ? principal*(rate/100)*(term/actual365(term,basis)) : principal*(rate/100);
        const taxRate=Number(snap.tax_rate??c.tax_rate_snapshot??0);
        const tax=gross*(taxRate/100);
        const extraDeductions=Array.isArray(snap.other_deductions)?snap.other_deductions.reduce((sum:number,item:any)=>{
          const kind=String(item?.type||"percentage");
          if(kind==="fixed")return sum+Math.max(0,Number(item?.amount||0));
          return sum+gross*Math.max(0,Number(item?.rate??item?.percentage??0))/100;
        },0):0;
        const totalDeductions=tax+extraDeductions;
        const net=Math.max(0,gross-totalDeductions);
        const activeCapital=Math.max(0,capitalReceived-principalRepaid);
        const maturityTotal=principal+net;
        return {...c,capital_received:capitalReceived,principal_repaid:principalRepaid,return_paid:returnAlreadyPaid,active_capital:activeCapital,return_type:returnType,day_count_basis:basis,display_rate:rate,gross_return:gross,estimated_deductions:totalDeductions,net_return:net,maturity_total:maturityTotal,verified_receipts:verifiedReceipts,settlements:paid};
      });
      let renewalElections:any[] = [];
      if (funder) {
        const {data:renewalRows,error:renewalError}=await admin.from("funding_renewal_elections")
          .select("id,source_commitment_id,election_type,requested_amount,target_opportunity_id,status,decision_reason,new_commitment_id,created_at,approved_at,processed_at")
          .eq("funder_id",funder.id).order("created_at",{ascending:false}).limit(200);
        if (renewalError) return jsonResponse({error:"Unable to load your maturity instructions."},500);
        renewalElections=renewalRows||[];
      }
      const portfolioWithRenewals=portfolio.map((item:any)=>({...item,renewal_election:renewalElections.find((e:any)=>e.source_commitment_id===item.id)||null}));
      return jsonResponse({success:true,investor,funder,opportunities:opportunities||[],commitments:portfolioWithRenewals,renewal_elections:renewalElections,receipts,settlements,live_offers_enabled:true,legal_notice:"Only approved published opportunities are shown. Only verified receipts count as invested capital. Figures are based on each commitment's locked terms snapshot and do not constitute a guarantee."});
    }

    // ==========================================
    // INVESTOR DIVIDENDS
    // ==========================================

    if (action === "dividends") {
      if (!account.investor_id) {
        return jsonResponse({
          success: true,
          dividends: [],
          message: "This account has no investor classification.",
        });
      }

      // Return each non-cancelled distribution, including declared/unpaid
      // allocations. The allocation is selected only for the authenticated
      // investor; no other shareholder data is returned.
      const { data: records, error } = await admin
        .from("dividends")
        .select(
          "id, period_label, status, paid_at, created_at, allocations, formula_version"
        )
        .not("status", "in", '("cancelled","void")')
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Dividend records:", error);
        return jsonResponse({ error: "Unable to load dividends." }, 500);
      }

      const investorId = Number(account.investor_id);

      const dividends = (records || []).flatMap((record) => {
        if (!Array.isArray(record.allocations)) return [];

        const allocation = record.allocations.find((entry: any) =>
          Number(entry?.investorId) === investorId &&
          entry?.isVirtual !== true
        );

        if (!allocation) return [];

        return [{
          dividend_id: record.id,
          period: record.period_label,
          status: record.status,
          paid_at: record.paid_at,
          created_at: record.created_at,
          amount: Number(
            allocation.final ??
            allocation.amount ??
            0
          ),
          stage1: Number(allocation.stage1 ?? 0),
          stage2: Number(allocation.stage2 ?? 0),
          percentage: Number(allocation.percentage ?? 0),
          formula_version: record.formula_version || null,
        }];
      });

      return jsonResponse({ success: true, dividends });
    }


    // ==========================================
    // PERSONAL EMPLOYEE PAYMENT HISTORY
    // Only records linked by the immutable staff_id are shown.
    // Legacy name-only rows are excluded because the employees
    // table has no staff_id relationship and cannot be safely mapped.
    // ==========================================
    if (action === "payments") {
      if (!account.staff_id) {
        return jsonResponse({ success: true, payments: [], legacy_history_not_linked: false, message: "This account has no employee classification." });
      }
      const { data, error } = await admin
        .from("transactions")
        .select("id, date, description, amount, fee, method, reference, status, payroll_run_id, reversal_of, reversed_at")
        .eq("staff_id", account.staff_id)
        .is("deleted_at", null)
        .in("status", ["approved", "posted"])
        .is("reversed_at", null)
        .is("reversal_of", null)
        .order("date", { ascending: false });
      if (error) {
        console.error("Personal payment history:", error);
        return jsonResponse({ error: "Unable to load your payment history." }, 500);
      }
      const payments = (data || []).map((item) => ({
        id: item.id,
        date: item.date,
        description: item.description || "Payroll payment",
        amount: Number(item.amount || 0),
        fee: Number(item.fee || 0),
        method: item.method || null,
        reference: item.reference || null,
        status: item.status,
        source: "staff_linked_finance_ledger"
      }));
      return jsonResponse({
        success: true,
        payments,
        legacy_history_not_linked: true,
        message: "Only payments linked directly to your employee record are shown. Older name-only records are not displayed because they cannot be safely matched to an employee."
      });
    }

    // ==========================================
    // EMPLOYEE CAP TABLE / EQUITY EARNINGS HISTORY
    // ==========================================
    if (action === "equity_earnings") {
      if (!account.investor_id) return jsonResponse({ success: true, investor: null, contributions: [], share_history: [], total_equity: 0 });
      const investorId = Number(account.investor_id);
      const [investorResult, investmentsResult, shareResult] = await Promise.all([
        admin.from("investors").select("id, name, investor_number, equity, joined_date, status").eq("id", investorId).is("deleted_at", null).maybeSingle(),
        admin.from("investments").select("id, date, amount, type, reference, notes, fee").eq("investor_id", investorId).is("deleted_at", null).order("date", { ascending: false }),
        admin.from("share_transactions").select("id, date, action, equity_before, equity_after, delta, reference, reason, notes").eq("investor_id", investorId).order("date", { ascending: false })
      ]);
      if (investorResult.error || investmentsResult.error || shareResult.error) {
        console.error("Equity earnings:", investorResult.error, investmentsResult.error, shareResult.error);
        return jsonResponse({ error: "Unable to load your cap-table history." }, 500);
      }
      return jsonResponse({
        success: true,
        investor: investorResult.data || null,
        contributions: investmentsResult.data || [],
        share_history: shareResult.data || [],
        total_equity: Number(investorResult.data?.equity || 0)
      });
    }

    return jsonResponse({ error: "Unknown action." }, 400);

  } catch (error) {
    console.error("Portal personal data function:", error);

    return jsonResponse(
      { error: "An unexpected server error occurred." },
      500
    );
  }
});
