import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (body: unknown, status=200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "Method not allowed." }, 405);
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return out({ error: "Sign in is required." }, 401);
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: auth, error: authErr } = await userClient.auth.getUser(token);
    if (authErr || !auth.user) return out({ error: "Your session is invalid. Sign in again." }, 401);
    const body = await req.json();
    const kind = String(body.kind || "");
    const action = String(body.action || "");
    const id = Number(body.id);
    if (!["leave","overtime"].includes(kind) || !["approve","reject"].includes(action) || !Number.isSafeInteger(id) || id <= 0) return out({ error: "Invalid approval request." }, 400);
    const moduleName = kind === "leave" ? "Leave" : "Overtime";
    const { data: allowed, error: permErr } = await userClient.rpc("portal_management_has_permission", { p_module: moduleName, p_permission: "approve" });
    if (permErr) throw permErr;
    if (!allowed) return out({ error: "You do not have approval permission for this workflow." }, 403);
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const now = new Date().toISOString();
    const reason = String(body.reason || "").trim().slice(0,1000);
    if (action === "reject" && !reason) return out({ error: "A rejection reason is required." }, 400);
    if (kind === "leave") {
      const { data: row, error } = await admin.from("leave_requests").select("id,staff_id,start_date,end_date,days,status").eq("id",id).maybeSingle();
      if (error) throw error;
      if (!row) return out({ error: "Leave request not found." },404);
      if (row.status !== "pending") return out({ error: "Only pending leave requests can be reviewed." },409);
      if (action === "approve") {
        const { data: overlaps, error: overlapErr } = await admin.from("leave_requests").select("id").eq("staff_id",row.staff_id).eq("status","approved").is("cancelled_at",null).neq("id",id).lte("start_date",row.end_date).gte("end_date",row.start_date).limit(1);
        if (overlapErr) throw overlapErr;
        if (overlaps?.length) return out({ error: "Approval blocked: another approved leave request overlaps these dates." },409);
      }
      const values = action === "approve"
        ? { status:"approved", approved_at:now, approved_by:auth.user.id, updated_at:now, updated_by:auth.user.id }
        : { status:"rejected", rejected_at:now, rejected_by:auth.user.id, rejection_reason:reason, updated_at:now, updated_by:auth.user.id };
      const { data: updated, error: updateErr } = await admin.from("leave_requests").update(values).eq("id",id).eq("status","pending").select("id,status").maybeSingle();
      if (updateErr) throw updateErr;
      if (!updated) return out({ error:"This leave request changed while it was being reviewed. Refresh and try again." },409);
    } else {
      const { data: row, error } = await admin.from("overtime_entries").select("id,hours,rate_per_hour,amount,status,payroll_run_id,transaction_id,paid_at").eq("id",id).maybeSingle();
      if (error) throw error;
      if (!row) return out({ error:"Overtime entry not found." },404);
      if (row.status !== "pending") return out({ error:"Only pending overtime entries can be reviewed." },409);
      if (action === "approve" && (!(Number(row.hours)>0) || !(Number(row.rate_per_hour)>0) || !(Number(row.amount)>0) || Math.abs(Number(row.amount)-Number(row.hours)*Number(row.rate_per_hour))>0.02)) return out({ error:"Overtime hours, rate and amount must be valid and consistent before approval." },400);
      const values = action === "approve"
        ? { status:"approved", approved_at:now, approved_by:auth.user.id, updated_at:now, updated_by:auth.user.id }
        : { status:"rejected", rejected_at:now, rejected_by:auth.user.id, rejection_reason:reason, updated_at:now, updated_by:auth.user.id };
      const { data: updated, error: updateErr } = await admin.from("overtime_entries").update(values).eq("id",id).eq("status","pending").is("payroll_run_id",null).is("transaction_id",null).is("paid_at",null).select("id,status").maybeSingle();
      if (updateErr) throw updateErr;
      if (!updated) return out({ error:"This overtime entry is linked to payroll, already paid, or changed while being reviewed." },409);
    }
    const { error: auditErr } = await admin.from("audit_logs").insert({ id:crypto.randomUUID(), user_name:auth.user.email || auth.user.id, action:kind+"_"+action, target:String(id), details:kind+" record "+action+"d by an authorised manager.", new_value:JSON.stringify({reason:reason || null}), warning:false });
    if (auditErr) console.error("Approval audit failed",auditErr);
    return out({ success:true, message:kind+" "+(action==="approve"?"approved":"rejected")+"." });
  } catch (e) {
    console.error("staff approval workflow",e);
    return out({ error:e instanceof Error ? e.message : "Approval failed." },500);
  }
});