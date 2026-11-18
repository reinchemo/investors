
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function response(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
        }
    });
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    if (req.method !== "POST") {
        return response({
            success: false,
            error: "Method not allowed."
        }, 405);
    }

    try {
        // 1. Verify authentication
        const authorization = req.headers.get("Authorization");

        if (!authorization || !authorization.startsWith("Bearer ")) {
            return response({
                success: false,
                error: "Authentication required."
            }, 401);
        }

        const token = authorization.replace("Bearer ", "");

        // User-scoped client: respects the logged-in user's permissions
        const userClient = createClient(
            SUPABASE_URL,
            SUPABASE_ANON_KEY,
            {
                global: {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                },
                auth: {
                    persistSession: false,
                    autoRefreshToken: false
                }
            }
        );

        // Admin client: used only inside this trusted Edge Function
        const admin = createClient(
            SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY,
            {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false
                }
            }
        );

        const authResult = await admin.auth.getUser(token);

        if (authResult.error || !authResult.data.user) {
            return response({
                success: false,
                error: "Invalid session."
            }, 401);
        }

        const user = authResult.data.user;
        const body = await req.json();
        const action = String(body.action || "");

        // =========================================
        // 2. LOAD TASK REVIEW QUEUE
        // =========================================

        if (action === "list_review_queue") {
            const permission = await userClient.rpc(
                "portal_management_can_view",
                {
                    p_module: "Tasks"
                }
            );

            if (permission.error || permission.data !== true) {
                return response({
                    success: false,
                    error: "You do not have permission to view the task review queue."
                }, 403);
            }

            const tasksResult = await admin
                .from("tasks")
                .select(`
                    id,
                    title,
                    description,
                    priority,
                    status,
                    progress_pct,
                    assignee_staff_id,
                    reviewer_staff_id,
                    start_date,
                    deadline,
                    instructions,
                    expected_result,
                    notes,
                    updated_at,
                    created_at
                `)
                .eq("status", "awaiting_review")
                .is("deleted_at", null)
                .order("updated_at", {
                    ascending: false
                });

            if (tasksResult.error) {
                console.error("Review queue error:", tasksResult.error);

                return response({
                    success: false,
                    error: "Unable to load the task review queue."
                }, 500);
            }

            const staffIds = Array.from(new Set(
                (tasksResult.data || [])
                    .map((task: any) => task.assignee_staff_id)
                    .filter((id: number | null) => id !== null)
            ));

            let staffMap: Record<string, any> = {};

            if (staffIds.length > 0) {
                const staffResult = await admin
                    .from("staff")
                    .select("id,employee_number,full_name,email")
                    .in("id", staffIds);

                if (staffResult.error) {
                    console.error("Staff lookup error:", staffResult.error);

                    return response({
                        success: false,
                        error: "Unable to load employee details."
                    }, 500);
                }

                for (const staff of staffResult.data || []) {
                    staffMap[String(staff.id)] = staff;
                }
            }

            const tasks = (tasksResult.data || []).map((task: any) => ({
                ...task,
                employee: staffMap[String(task.assignee_staff_id)] || null
            }));

            return response({
                success: true,
                tasks
            });
        }

        // =========================================
        // 3. APPROVE OR REJECT A TASK
        // =========================================

        if (action === "review_task") {
            const permission = await userClient.rpc(
                "portal_management_can_edit",
                {
                    p_module: "Tasks"
                }
            );

            if (permission.error || permission.data !== true) {
                return response({
                    success: false,
                    error: "You do not have permission to review tasks."
                }, 403);
            }

            const taskId = String(body.task_id || "").trim();
            const decision = String(body.decision || "").trim().toLowerCase();
            const reviewNote = String(body.review_note || "").trim();

            if (!taskId) {
                return response({
                    success: false,
                    error: "Task reference is required."
                }, 400);
            }

            if (!["approved", "rejected"].includes(decision)) {
                return response({
                    success: false,
                    error: "Choose either approve or reject."
                }, 400);
            }

            if (decision === "rejected" && !reviewNote) {
                return response({
                    success: false,
                    error: "A reason is required when rejecting a task."
                }, 400);
            }

            // Find the task
            const taskResult = await admin
                .from("tasks")
                .select("id,title,status,assignee_staff_id")
                .eq("id", taskId)
                .is("deleted_at", null)
                .maybeSingle();

            if (taskResult.error || !taskResult.data) {
                return response({
                    success: false,
                    error: "Task not found."
                }, 404);
            }

            const task = taskResult.data;

            if (task.status !== "awaiting_review") {
                return response({
                    success: false,
                    error: "This task is no longer awaiting review. Refresh the queue."
                }, 409);
            }

            // =====================================
            // 4. PREVENT SELF-REVIEW
            // =====================================

            const managerStaffResult = await userClient.rpc(
                "portal_my_staff_id"
            );

            if (managerStaffResult.error) {
                console.error(
                    "Manager staff verification failed:",
                    managerStaffResult.error
                );

                return response({
                    success: false,
                    error: "Unable to verify your management identity. Please try again."
                }, 500);
            }

            if (managerStaffResult.data !== null) {
                if (
                    String(managerStaffResult.data) ===
                    String(task.assignee_staff_id)
                ) {
                    return response({
                        success: false,
                        error: "You cannot review a task assigned to yourself."
                    }, 403);
                }
            }

            // =====================================
            // 5. VALIDATE STATUS TRANSITION
            // =====================================

            const transitionResult = await admin.rpc(
                "is_valid_task_transition",
                {
                    p_from: "awaiting_review",
                    p_to: decision
                }
            );

            if (
                transitionResult.error ||
                transitionResult.data !== true
            ) {
                console.error(
                    "Task transition validation failed:",
                    transitionResult.error
                );

                return response({
                    success: false,
                    error: "The requested task status transition is not allowed."
                }, 400);
            }

            // =====================================
            // 6. SAVE THE MANAGEMENT DECISION
            // =====================================

            const updateResult = await admin
                .from("tasks")
                .update({
                    status: decision,
                    updated_at: new Date().toISOString(),
                    updated_by: user.email || user.id
                })
                .eq("id", taskId)
                .eq("status", "awaiting_review")
                .is("deleted_at", null)
                .select("id,title,status,progress_pct,updated_at")
                .maybeSingle();

            if (updateResult.error) {
                console.error(
                    "Task review update error:",
                    updateResult.error
                );

                return response({
                    success: false,
                    error: "Unable to save the task review."
                }, 500);
            }

            if (!updateResult.data) {
                return response({
                    success: false,
                    error: "Another reviewer may have already handled this task. Refresh the queue."
                }, 409);
            }

            // =====================================
            // 7. RECORD THE REVIEW COMMENT
            // =====================================

            let commentBody = "";

            if (decision === "approved") {
                commentBody = "Task approved by management.";

                if (reviewNote) {
                    commentBody += " Review note: " + reviewNote;
                }
            } else {
                commentBody =
                    "Task rejected by management. Reason: " + reviewNote;
            }

            const commentResult = await admin
                .from("task_comments")
                .insert({
                    task_id: taskId,
                    author: user.email || "Management",
                    body: commentBody,
                    kind: "management_review"
                });

            if (commentResult.error) {
                console.error(
                    "Review history insert error:",
                    commentResult.error
                );

                return response({
                    success: true,
                    task: updateResult.data,
                    warning: "The task decision was saved, but the review note could not be added to task history."
                });
            }

            return response({
                success: true,
                task: updateResult.data,
                message: decision === "approved"
                    ? "Task approved successfully."
                    : "Task rejected successfully."
            });
        }

        // =========================================
        // 8. UNKNOWN ACTION
        // =========================================

        return response({
            success: false,
            error: "Unsupported action."
        }, 400);

    } catch (error) {
        console.error(
            "Management task function error:",
            error
        );

        return response({
            success: false,
            error: error instanceof Error
                ? error.message
                : "An unexpected server error occurred."
        }, 500);
    }
});
