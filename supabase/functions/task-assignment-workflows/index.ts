import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return reply({ error: "Authentication required." }, 401);
    const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    const auth = await admin.auth.getUser(token);
    if (auth.error || !auth.data.user) return reply({ error: "Invalid session." }, 401);
    const user = auth.data.user;
    const userClient = createClient(URL, ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid request." }, 400);
    const action = String(body.action || "");

    const managementPermission = async (kind: "view" | "edit") => {
      const { data, error } = await userClient.rpc(kind === "view" ? "portal_management_can_view" : "portal_management_can_edit", { p_module: "Tasks" });
      return !error && data === true;
    };
    const employeeAccount = async () => {
      const { data, error } = await admin.from("personal_portal_accounts").select("staff_id,account_status").eq("user_id", user.id).maybeSingle();
      if (error || !data || data.account_status !== "active" || !data.staff_id) return null;
      const { data: staff } = await admin.from("staff").select("id,full_name,status,deleted_at").eq("id", data.staff_id).maybeSingle();
      if (!staff || staff.status !== "active" || staff.deleted_at) return null;
      return staff;
    };
    const staffId = Number(body.staff_id);
    const taskId = String(body.task_id || "").trim();

    if (action === "assign_task") {
      if (!(await managementPermission("edit"))) return reply({ error: "Tasks edit permission required." }, 403);
      if (!taskId || (body.staff_ids !== undefined && (!Array.isArray(body.staff_ids) || body.staff_ids.length > 50))) return reply({ error: "A valid task and employee list are required." }, 400);
      const mode = String(body.assignment_mode || "single");
      if (!["single","everyone_must_complete","first_to_claim","open_pool"].includes(mode)) return reply({ error: "Invalid assignment mode." }, 400);
      if (mode === "single" && body.staff_ids.length !== 1) return reply({ error: "Single assignment accepts exactly one employee." }, 400);
      const rawIds = Array.isArray(body.staff_ids) ? body.staff_ids : [];
      const ids = [...new Set(rawIds.map((v: unknown) => Number(v)))];
      if ((mode !== "first_to_claim" && mode !== "open_pool" && ids.length < 1) || ids.some((v: number) => !Number.isSafeInteger(v) || v <= 0)) return reply({ error: "Invalid employee selection." }, 400);
      const { data: task, error: taskErr } = await admin.from("tasks").select("id,status").eq("id", taskId).is("deleted_at", null).maybeSingle();
      if (taskErr || !task) return reply({ error: "Task not found." }, 404);
      const { data: staff, error: staffErr } = await admin.from("staff").select("id").in("id", ids).eq("status", "active").is("deleted_at", null);
      if (staffErr || (staff || []).length !== ids.length) return reply({ error: "Every selected employee must be active." }, 400);
      const rows = mode === "first_to_claim" || mode === "open_pool" ? [] : ids.map((id: number) => ({ task_id: taskId, staff_id: id, assignment_state: "assigned" }));
      if (rows.length) {
        const { error } = await admin.from("task_assignments").upsert(rows, { onConflict: "task_id,staff_id" });
        if (error) throw error;
      }
      const primary = rows.length ? ids[0] : null;
      const { error: updateErr } = await admin.from("tasks").update({
        assignment_mode: mode, assignee_staff_id: primary, updated_at: new Date().toISOString(),
        updated_by: user.email || user.id,
      }).eq("id", taskId).is("deleted_at", null);
      if (updateErr) throw updateErr;
      const { error: commentErr } = await admin.from("task_comments").insert({
        task_id: taskId, author: user.email || "Management",
        body: mode === "first_to_claim" || mode === "open_pool" ? `Task published to ${mode.replaceAll("_"," ")} pool.` : `Task assigned to ${ids.length} employee(s) using ${mode} mode.`,
        kind: "assignment_change",
      });
      if (commentErr) console.error("Task assignment history warning", commentErr);
      return reply({ success: true, task_id: taskId, assignment_mode: mode, assigned_staff_ids: ids });
    }

    if (action === "claim_task") {
      const employee = await employeeAccount();
      if (!employee) return reply({ error: "An active employee-linked account is required." }, 403);
      if (!taskId) return reply({ error: "Task reference required." }, 400);
      const { data: task, error } = await admin.from("tasks").select("id,title,status,assignment_mode,assignee_staff_id").eq("id", taskId).is("deleted_at", null).maybeSingle();
      if (error || !task) return reply({ error: "Task not found." }, 404);
      if (!["first_to_claim","open_pool"].includes(task.assignment_mode)) return reply({ error: "This task is not available for claiming." }, 409);
      if (!["assigned","accepted"].includes(task.status)) return reply({ error: "This task is no longer available." }, 409);
      const { data: existing } = await admin.from("task_assignments").select("id,assignment_state").eq("task_id", taskId).eq("staff_id", employee.id).maybeSingle();
      if (existing && !["declined"].includes(existing.assignment_state)) return reply({ error: "You already have an assignment for this task." }, 409);
      const { data: claimed, error: claimErr } = await admin.from("task_assignments").upsert({
        task_id: taskId, staff_id: employee.id, assignment_state: "claimed", claimed_at: new Date().toISOString(),
      }, { onConflict: "task_id,staff_id" }).select("id").single();
      if (claimErr) {
        if (task.assignment_mode === "first_to_claim") return reply({ error: "Another employee may have claimed this task first. Refresh the task list." }, 409);
        throw claimErr;
      }
      if (task.assignment_mode === "first_to_claim") {
        const { data: updated } = await admin.from("tasks").update({
          assignee_staff_id: employee.id, status: "accepted", updated_at: new Date().toISOString(),
        }).eq("id", taskId).is("deleted_at", null).is("assignee_staff_id", null).select("id").maybeSingle();
        if (!updated) {
          await admin.from("task_assignments").delete().eq("id", claimed.id);
          return reply({ error: "Another employee claimed this task first." }, 409);
        }
      }
      await admin.from("task_comments").insert({ task_id: taskId, author: employee.full_name, body: "Task claimed by employee.", kind: "assignment_claim" });
      return reply({ success: true, task_id: taskId, assignment_id: claimed.id });
    }

    if (action === "list_my_assignments") {
      const employee = await employeeAccount();
      if (!employee) return reply({ error: "An active employee-linked account is required." }, 403);
      const { data, error } = await admin.from("task_assignments").select("id,task_id,assignment_state,progress_pct,assigned_at,claimed_at,completed_at,tasks(id,title,description,priority,status,deadline,assignment_mode,service_status)").eq("staff_id", employee.id).order("assigned_at", { ascending: false }).limit(300);
      if (error) throw error;
      const { data: pool, error: poolErr } = await admin.from("tasks").select("id,title,description,priority,status,deadline,assignment_mode,service_status").in("assignment_mode", ["first_to_claim","open_pool"]).is("assignee_staff_id", null).is("deleted_at", null).limit(100);
      if (poolErr) throw poolErr;
      return reply({ success: true, assignments: data || [], claimable_tasks: pool || [] });
    }

    if (action === "update_assignment") {
      const employee = await employeeAccount();
      if (!employee) return reply({ error: "An active employee-linked account is required." }, 403);
      if (!taskId) return reply({ error: "Task reference required." }, 400);
      const { data: assignment, error } = await admin.from("task_assignments").select("id,assignment_state,progress_pct").eq("task_id", taskId).eq("staff_id", employee.id).maybeSingle();
      if (error || !assignment) return reply({ error: "Assignment not found." }, 404);
      const allowed = ["accepted","in_progress","awaiting_review","rejected","completed","declined"];
      const next = String(body.assignment_state || assignment.assignment_state);
      if (!allowed.includes(next)) return reply({ error: "Invalid assignment status." }, 400);
      const progress = body.progress_pct === undefined ? assignment.progress_pct : Number(body.progress_pct);
      if (!Number.isInteger(progress) || progress < 0 || progress > 100) return reply({ error: "Progress must be 0-100." }, 400);
      const transitions: Record<string,string[]> = {
        claimed:["accepted","declined"], assigned:["accepted","declined"],
        accepted:["in_progress","declined"], in_progress:["awaiting_review"],
        rejected:["in_progress"], awaiting_review:[], approved:[], completed:[], declined:[],
      };
      if (next !== assignment.assignment_state && !(transitions[assignment.assignment_state] || []).includes(next)) return reply({ error: "This assignment transition is not allowed." }, 409);
      if (next === "awaiting_review" && progress !== 100) return reply({ error: "Complete 100% before requesting review." }, 400);
      if (next !== "awaiting_review" && progress === 100 && next !== "completed") return reply({ error: "Submit completed work for review." }, 400);
      const { data: updated, error: updateErr } = await admin.from("task_assignments").update({
        assignment_state: next, progress_pct: progress, updated_at: new Date().toISOString(),
        completed_at: next === "completed" ? new Date().toISOString() : null,
      }).eq("id", assignment.id).eq("assignment_state", assignment.assignment_state).select("*").maybeSingle();
      if (updateErr) throw updateErr;
      if (!updated) return reply({ error: "Assignment changed concurrently. Refresh and retry." }, 409);
      await admin.from("task_comments").insert({
        task_id: taskId, author: employee.full_name,
        body: `Assignment status changed to ${next}; progress ${progress}%.`,
        kind: "assignment_update",
      });
      const { data: parent } = await admin.from("tasks").select("assignment_mode,status").eq("id", taskId).is("deleted_at", null).maybeSingle();
      if (parent) {
        if (parent.assignment_mode === "single" || parent.assignment_mode === "first_to_claim") {
          const parentStatus = next === "awaiting_review" ? "awaiting_review" : next === "in_progress" ? "in_progress" : next === "accepted" ? "accepted" : null;
          if (parentStatus) await admin.from("tasks").update({ status: parentStatus, progress_pct: progress, updated_at: new Date().toISOString(), updated_by: user.email || user.id }).eq("id", taskId).is("deleted_at", null);
        } else if (parent.assignment_mode === "everyone_must_complete") {
          const { data: allRows } = await admin.from("task_assignments").select("assignment_state").eq("task_id", taskId);
          const states = (allRows || []).map((row: any) => row.assignment_state);
          const allSubmitted = states.length > 0 && states.every((state: string) => ["awaiting_review","approved","completed"].includes(state));
          const anyRejected = states.some((state: string) => state === "rejected");
          const anyWorking = states.some((state: string) => ["claimed","accepted","in_progress","assigned"].includes(state));
          const aggregate = allSubmitted ? "awaiting_review" : anyRejected ? "rejected" : anyWorking ? "in_progress" : null;
          if (aggregate) await admin.from("tasks").update({ status: aggregate, updated_at: new Date().toISOString(), updated_by: user.email || user.id }).eq("id", taskId).is("deleted_at", null);
        }
      }
      return reply({ success: true, assignment: updated });
    }

    if (action === "set_service_status") {
      if (!(await managementPermission("edit"))) return reply({ error: "Tasks edit permission required." }, 403);
      const allowed = ["not_started","on_the_way","arrived","blocked","waiting_for_materials","working","finished"];
      const status = String(body.service_status || "");
      if (!taskId || !allowed.includes(status)) return reply({ error: "Valid task and service status required." }, 400);
      const { data, error } = await admin.from("tasks").update({ service_status: status, updated_at: new Date().toISOString(), updated_by: user.email || user.id }).eq("id", taskId).is("deleted_at", null).select("id,service_status").maybeSingle();
      if (error) throw error;
      if (!data) return reply({ error: "Task not found." }, 404);
      await admin.from("task_comments").insert({ task_id: taskId, author: user.email || "Management", body: `Service status changed to ${status}.`, kind: "service_status" });
      return reply({ success: true, task: data });
    }

    return reply({ error: "Unsupported action." }, 400);
  } catch (error) {
    console.error("Task assignment workflow error", error);
    return reply({ error: "Unable to process task assignment request." }, 500);
  }
});