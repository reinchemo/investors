
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

    if (!account || account.account_status !== "active" || !account.staff_id) {
      return response({
        error: "An active employee-linked portal account is required.",
      }, 403);
    }

    const body = await req.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "Invalid request." }, 400);
    }

    const action = String(body.action || "");
    const staffId = account.staff_id;

    // Confirm the employee record is still active.
    const { data: staff, error: staffError } = await admin
      .from("staff")
      .select("id, full_name, status, deleted_at")
      .eq("id", staffId)
      .maybeSingle();

    if (staffError) throw staffError;

    if (!staff || staff.deleted_at || staff.status !== "active") {
      return response({ error: "Your employee account is not active." }, 403);
    }

    // EMPLOYEE: LIST ONLY THE SIGNED-IN EMPLOYEE'S TASKS
    if (action === "list_tasks") {
      const { data: tasks, error: tasksError } = await admin
        .from("tasks")
        .select("id, title, description, priority, status, progress_pct, start_date, deadline, instructions, expected_result, notes, created_at, updated_at")
        .eq("assignee_staff_id", staffId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(300);

      if (tasksError) throw tasksError;

      return response({ success: true, tasks: tasks || [] });
    }

    // All task actions require a task ID and ownership verification.
    const taskId = String(body.task_id || "").trim();

    if (!taskId || taskId.length > 150) {
      return response({ error: "A valid task reference is required." }, 400);
    }

    const { data: task, error: taskError } = await admin
      .from("tasks")
      .select("id, title, status, progress_pct, assignee_staff_id, deleted_at")
      .eq("id", taskId)
      .eq("assignee_staff_id", staffId)
      .is("deleted_at", null)
      .maybeSingle();

    if (taskError) throw taskError;

    if (!task) {
      return response({ error: "Task not found or not assigned to your account." }, 404);
    }

    // EMPLOYEE: READ TASK COMMENTS
    if (action === "list_comments") {
      const { data, error } = await admin
        .from("task_comments")
        .select("id, task_id, author, body, kind, created_at")
        .eq("task_id", taskId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });

      if (error) throw error;

      return response({
        success: true,
        comments: data || [],
      });
    }

    // EMPLOYEE: ADD A TASK COMMENT
    if (action === "add_comment") {
      const comment = String(body.comment || "").trim();

      if (!comment || comment.length > 3000) {
        return response({
          error: "Enter a comment of no more than 3,000 characters.",
        }, 400);
      }

      const { data, error } = await admin
        .from("task_comments")
        .insert({
          task_id: taskId,
          author: staff.full_name,
          body: comment,
          kind: "employee_update",
        })
        .select("id, task_id, author, body, kind, created_at")
        .single();

      if (error) throw error;

      return response({
        success: true,
        comment: data,
      });
    }

    // EMPLOYEE: UPDATE TASK PROGRESS / REQUEST REVIEW
    if (action === "update_progress") {
      const progress = Number(body.progress_pct);

      if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
        return response({
          error: "Progress must be a whole number between 0 and 100.",
        }, 400);
      }

      const currentStatus = String(task.status || "").toLowerCase();
      const requestedStatus = body.status
        ? String(body.status).toLowerCase()
        : currentStatus;

      const employeeStatuses = [
        "accepted",
        "in_progress",
        "awaiting_review",
      ];

      if (!employeeStatuses.includes(requestedStatus)) {
        return response({
          error: "Employees cannot set this task status.",
        }, 403);
      }

      // Do not allow employees to bypass the review workflow.
      if (requestedStatus === "awaiting_review" && progress !== 100) {
        return response({
          error: "Set progress to 100% before requesting review.",
        }, 400);
      }

      if (requestedStatus !== "awaiting_review" && progress === 100) {
        return response({
          error: "Submit the task for review when progress reaches 100%.",
        }, 400);
      }

      if (requestedStatus !== currentStatus) {
        const { data: valid, error: transitionError } = await admin.rpc(
          "is_valid_task_transition",
          {
            p_from: currentStatus,
            p_to: requestedStatus,
          },
        );

        if (transitionError) throw transitionError;

        if (!valid) {
          return response({
            error: `The task cannot move from ${currentStatus} to ${requestedStatus}.`,
          }, 409);
        }
      }

      const updateValues: Record<string, unknown> = {
        progress_pct: progress,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      };

      if (requestedStatus !== currentStatus) {
        updateValues.status = requestedStatus;
      }

      // Compare the old status as well, preventing a stale update
      // from overwriting a management review or another task change.
      const { data: updated, error: updateError } = await admin
        .from("tasks")
        .update(updateValues)
        .eq("id", taskId)
        .eq("assignee_staff_id", staffId)
        .eq("status", task.status)
        .is("deleted_at", null)
        .select("id, title, status, progress_pct, updated_at")
        .maybeSingle();

      if (updateError) throw updateError;

      if (!updated) {
        return response({
          error: "This task changed while you were updating it. Refresh and try again.",
        }, 409);
      }

      // Record a readable history entry in the existing comments table.
      const note = String(body.note || "").trim();

      const historyText = [
        `Progress updated to ${progress}%.`,
        requestedStatus !== currentStatus
          ? `Status changed from ${currentStatus} to ${requestedStatus}.`
          : "",
        note ? `Employee note: ${note}` : "",
      ].filter(Boolean).join(" ");

      const { error: historyError } = await admin
        .from("task_comments")
        .insert({
          task_id: taskId,
          author: staff.full_name,
          body: historyText,
          kind: "progress_update",
        });

      if (historyError) {
        console.error("Task update history failed:", historyError);

        return response({
          success: true,
          task: updated,
          warning: "Task progress was saved, but its history note could not be recorded. Contact management.",
        });
      }

      return response({
        success: true,
        task: updated,
      });
    }

    return response({ error: "Unknown task action." }, 400);

  } catch (error) {
    console.error("Personal task function error:", error);
    return response({
      error: "Unable to process the task request. Please try again.",
    }, 500);
  }
});
