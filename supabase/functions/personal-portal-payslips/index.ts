import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function getServiceRoleKey(): string {
    const directKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (directKey) return directKey;

    const rawKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
    if (!rawKeys) return "";

    try {
        const parsed = JSON.parse(rawKeys);

        if (Array.isArray(parsed)) {
            const match = parsed.find((item) => {
                const value = typeof item === "string" ? item : item?.key;

                return typeof value === "string" &&
                    (value.startsWith("sb_secret_") || value.startsWith("eyJ"));
            });

            return typeof match === "string" ? match : match?.key ?? "";
        }

        if (parsed && typeof parsed === "object") {
            for (const [name, value] of Object.entries(parsed)) {
                if (
                    typeof value === "string" &&
                    (name.toLowerCase().includes("service") ||
                        value.startsWith("sb_secret_"))
                ) {
                    return value;
                }
            }

            for (const value of Object.values(parsed)) {
                if (typeof value === "string" && value.startsWith("eyJ")) {
                    return value;
                }
            }
        }
    } catch {
        if (rawKeys.startsWith("sb_secret_") || rawKeys.startsWith("eyJ")) {
            return rawKeys;
        }
    }

    return "";
}

const SERVICE_ROLE_KEY = getServiceRoleKey();

const allowedOrigins = (
    Deno.env.get("ALLOWED_ORIGINS") ??
    "http://localhost:5500,http://127.0.0.1:5500"
).split(",").map((origin) => origin.trim()).filter(Boolean);

const supabaseAdmin = createClient(
    SUPABASE_URL,
    SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

function corsHeaders(origin: string | null): Record<string, string> {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Headers":
            "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin"
    };

    if (origin && allowedOrigins.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    }

    return headers;
}

function jsonResponse(
    status: number,
    data: Record<string, unknown>,
    origin: string | null
): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...corsHeaders(origin),
            "Content-Type": "application/json"
        }
    });
}

Deno.serve(async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: corsHeaders(origin)
        });
    }

    if (request.method !== "POST") {
        return jsonResponse(405, {
            error: "Method not allowed."
        }, origin);
    }

    if (origin && !allowedOrigins.includes(origin)) {
        return jsonResponse(403, {
            error: "Origin not allowed."
        }, origin);
    }

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
        console.error("Missing server configuration.");

        return jsonResponse(500, {
            error: "Server configuration is incomplete."
        }, origin);
    }

    try {
        const authorization = request.headers.get("Authorization");
        const match = authorization?.match(/^Bearer\s+(.+)$/i);
        const token = match?.[1];

        if (!token) {
            return jsonResponse(401, {
                error: "Authentication is required."
            }, origin);
        }

        const {
            data: { user },
            error: authError
        } = await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            return jsonResponse(401, {
                error: "Invalid or expired login session."
            }, origin);
        }

        // Find the personal portal account belonging to this user.
        const { data: account, error: accountError } = await supabaseAdmin
            .from("personal_portal_accounts")
            .select("staff_id, account_status")
            .eq("user_id", user.id)
            .maybeSingle();

        if (accountError) {
            console.error("Portal account lookup failed:", accountError.message);

            return jsonResponse(500, {
                error: "Unable to verify your portal account."
            }, origin);
        }

        if (!account || account.account_status !== "active") {
            return jsonResponse(403, {
                error: "Your personal portal account is unavailable."
            }, origin);
        }

        if (!account.staff_id) {
            return jsonResponse(403, {
                error: "This account does not have an employee payroll profile."
            }, origin);
        }

        // Retrieve only this employee's approved or posted payroll items.
        const { data: payrollItems, error: payrollError } = await supabaseAdmin
            .from("payroll_items")
            .select(`
                id,
                gross,
                deductions,
                net,
                notes,
                payroll_runs!payroll_items_run_id_fkey (
                    id,
                    period,
                    run_date,
                    status,
                    approved_at,
                    posted_at
                )
            `)
            .eq("staff_id", account.staff_id)
            .in("payroll_runs.status", ["approved", "posted"])
            .order("created_at", { ascending: false })
            .limit(100);

        if (payrollError) {
            console.error("Payroll retrieval failed:", payrollError.message);

            return jsonResponse(500, {
                error: "Unable to retrieve your approved payroll records."
            }, origin);
        }

        const records = (payrollItems ?? []).filter((item: any) => {
            const run = Array.isArray(item.payroll_runs)
                ? item.payroll_runs[0]
                : item.payroll_runs;

            return run &&
                ["approved", "posted"].includes(
                    String(run.status).toLowerCase()
                );
        }).map((item: any) => {
            const run = Array.isArray(item.payroll_runs)
                ? item.payroll_runs[0]
                : item.payroll_runs;

            return {
                id: item.id,
                gross: item.gross,
                deductions: item.deductions,
                net: item.net,
                notes: item.notes,
                period: run.period,
                run_date: run.run_date,
                status: run.status,
                approved_at: run.approved_at,
                posted_at: run.posted_at
            };
        });

        return jsonResponse(200, {
            success: true,
            records
        }, origin);

    } catch (error) {
        console.error("Payslip function error:", error);

        return jsonResponse(500, {
            error: "An unexpected server error occurred."
        }, origin);
    }
});