
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
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function jsonResponse(
  status: number,
  data: Record<string, unknown>,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");

  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function validId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

async function writeAuditLog(input: {
  actor: string;
  action: string;
  entityId: string;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  deviceInfo: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from("audit_log")
    .insert({
      actor: input.actor,
      action: input.action,
      module: "Personal Portal Accounts",
      entity_id: input.entityId,
      record_before: input.before,
      record_after: input.after,
      changed_fields: ["account_status", "staff_id", "investor_id"],
      reason: "Personal portal account administration",
      ip_address: input.ipAddress,
      device_info: input.deviceInfo,
    });

  if (error) {
    console.error("Audit log insert failed:", error.message);
    throw new Error("Account change could not be fully audited.");
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      405,
      { error: "Method not allowed." },
      origin,
    );
  }

  if (origin && !allowedOrigins.includes(origin)) {
    return jsonResponse(
      403,
      { error: "Origin not allowed." },
      origin,
    );
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing Supabase server configuration.");
    return jsonResponse(
      500,
      { error: "Server configuration is incomplete." },
      origin,
    );
  }

  try {
    const token = getBearerToken(request);

    if (!token) {
      return jsonResponse(
        401,
        { error: "Authentication is required." },
        origin,
      );
    }

    // Verify the actual caller using Supabase Auth.
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return jsonResponse(
        401,
        { error: "Invalid or expired login session." },
        origin,
      );
    }

    // Only a Full Administrator may manage portal accounts.
    const { data: roleRows, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("roles!inner(is_full_admin)")
      .eq("user_id", user.id);

    if (roleError) {
      console.error("Administrator verification failed:", roleError.message);
      return jsonResponse(
        500,
        { error: "Unable to verify administrator permissions." },
        origin,
      );
    }

    const isFullAdmin = (roleRows ?? []).some((row: any) => {
      const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
      return role?.is_full_admin === true;
    });

    if (!isFullAdmin) {
      return jsonResponse(
        403,
        { error: "Full Administrator permission is required." },
        origin,
      );
    }

    let body: Record<string, unknown>;

    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        400,
        { error: "Request body must be valid JSON." },
        origin,
      );
    }

    const action = body.action;

    // =====================================================
    // ACTION 1: LIST USERS AND AVAILABLE RECORDS
    // =====================================================

    if (action === "list_users") {
      const requestedPage = Number(body.page ?? 1);
      const requestedPerPage = Number(body.per_page ?? 100);

      if (
        !Number.isInteger(requestedPage) || requestedPage < 1 ||
        !Number.isInteger(requestedPerPage) ||
        requestedPerPage < 1 || requestedPerPage > 100
      ) {
        return jsonResponse(
          400,
          {
            error:
              "page must be positive and per_page must be between 1 and 100.",
          },
          origin,
        );
      }

      const { data: authData, error: authListError } =
        await supabaseAdmin.auth.admin.listUsers({
          page: requestedPage,
          perPage: requestedPerPage,
        });

      if (authListError) {
        console.error("User list retrieval failed:", authListError.message);
        return jsonResponse(
          500,
          { error: "Unable to retrieve existing user accounts." },
          origin,
        );
      }

      const authUsers = authData.users ?? [];
      const userIds = authUsers.map((item) => item.id);

      let profiles: any[] = [];
      let portalAccounts: any[] = [];

      if (userIds.length > 0) {
        const [
          { data: profileRows, error: profileError },
          { data: accountRows, error: accountError },
        ] = await Promise.all([
          supabaseAdmin
            .from("profiles")
            .select("id, full_name, email, phone, starlink_id")
            .in("id", userIds),

          supabaseAdmin
            .from("personal_portal_accounts")
            .select(
              "id, user_id, staff_id, investor_id, account_status",
            )
            .in("user_id", userIds),
        ]);

        if (profileError || accountError) {
          console.error(
            "Portal account list details failed:",
            profileError?.message ?? accountError?.message,
          );

          return jsonResponse(
            500,
            { error: "Unable to retrieve portal account details." },
            origin,
          );
        }

        profiles = profileRows ?? [];
        portalAccounts = accountRows ?? [];
      }

      const profileById = new Map(
        profiles.map((item) => [item.id, item]),
      );

      const accountByUserId = new Map(
        portalAccounts.map((item) => [item.user_id, item]),
      );

      const searchTerm = typeof body.search === "string"
        ? body.search.trim().toLowerCase().slice(0, 100)
        : "";

      const users = authUsers.map((authUser) => {
        const profile = profileById.get(authUser.id) ?? null;
        const account = accountByUserId.get(authUser.id) ?? null;

        return {
          id: authUser.id,
          email: authUser.email ?? profile?.email ?? null,
          created_at: authUser.created_at,
          last_sign_in_at: authUser.last_sign_in_at ?? null,
          full_name: profile?.full_name ??
            authUser.user_metadata?.full_name ??
            authUser.user_metadata?.name ??
            null,
          phone: profile?.phone ?? null,
          starlink_id: profile?.starlink_id ?? null,
          portal_account: account,
        };
      }).filter((item) => {
        if (!searchTerm) return true;

        return [
          item.email,
          item.full_name,
          item.phone,
          item.starlink_id,
          item.id,
        ].some((value) =>
          typeof value === "string" &&
          value.toLowerCase().includes(searchTerm)
        );
      });

      const [
        { data: staffRows, error: staffListError },
        { data: investorRows, error: investorListError },
      ] = await Promise.all([
        supabaseAdmin
          .from("staff")
          .select("id, employee_number, full_name, role, status")
          .is("deleted_at", null)
          .order("full_name", { ascending: true })
          .limit(500),

        supabaseAdmin
          .from("investors")
          .select("id, investor_number, name, status")
          .is("deleted_at", null)
          .order("name", { ascending: true })
          .limit(500),
      ]);

      if (staffListError || investorListError) {
        console.error(
          "Employee/investor list retrieval failed:",
          staffListError?.message ?? investorListError?.message,
        );

        return jsonResponse(
          500,
          { error: "Unable to retrieve employee and investor records." },
          origin,
        );
      }

      return jsonResponse(
        200,
        {
          success: true,
          page: requestedPage,
          per_page: requestedPerPage,
          has_more: authUsers.length === requestedPerPage,
          search_applies_to_current_page: true,
          users,
          staff: staffRows ?? [],
          investors: investorRows ?? [],
        },
        origin,
      );
    }

    // =====================================================
    // ACTIONS BELOW REQUIRE A TARGET USER ID
    // =====================================================

    const targetUserId = body.user_id;

    if (
      typeof targetUserId !== "string" ||
      targetUserId.trim().length === 0
    ) {
      return jsonResponse(
        400,
        { error: "A valid target user_id is required." },
        origin,
      );
    }

    // Confirm that the target is an existing Supabase Auth user.
    const {
      data: { user: targetUser },
      error: targetUserError,
    } = await supabaseAdmin.auth.admin.getUserById(targetUserId);

    if (targetUserError || !targetUser) {
      return jsonResponse(
        404,
        { error: "The target Supabase user was not found." },
        origin,
      );
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("personal_portal_accounts")
      .select("*")
      .eq("user_id", targetUserId)
      .maybeSingle();

    if (existingError) {
      console.error("Account lookup failed:", existingError.message);

      return jsonResponse(
        500,
        { error: "Unable to retrieve the portal account." },
        origin,
      );
    }

    const before = existing ?? null;

    // =====================================================
    // ACTION 2: SUSPEND OR ACTIVATE
    // =====================================================

    if (action === "suspend" || action === "activate") {
      if (!existing) {
        return jsonResponse(
          404,
          { error: "No personal portal account exists for this user." },
          origin,
        );
      }

      const newStatus = action === "suspend" ? "suspended" : "active";

      const { data: updated, error: updateError } = await supabaseAdmin
        .from("personal_portal_accounts")
        .update({
          account_status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", targetUserId)
        .select()
        .single();

      if (updateError || !updated) {
        console.error("Account status update failed:", updateError?.message);

        return jsonResponse(
          500,
          { error: "Unable to update the portal account status." },
          origin,
        );
      }

      await writeAuditLog({
        actor: user.id,
        action: `PORTAL_ACCOUNT_${action.toUpperCase()}`,
        entityId: updated.id,
        before,
        after: updated,
        ipAddress: request.headers.get("x-forwarded-for"),
        deviceInfo: request.headers.get("user-agent"),
      });

      return jsonResponse(
        200,
        {
          success: true,
          message: `Portal account ${newStatus} successfully.`,
          account: updated,
        },
        origin,
      );
    }

    // =====================================================
    // ACTION 3: LINK EMPLOYEE AND/OR INVESTOR
    // =====================================================

    if (action === "link") {
      const requestedStaffId = body.staff_id;
      const requestedInvestorId = body.investor_id;

      if (
        requestedStaffId !== undefined &&
        requestedStaffId !== null &&
        !validId(requestedStaffId)
      ) {
        return jsonResponse(
          400,
          { error: "staff_id must be a positive integer." },
          origin,
        );
      }

      if (
        requestedInvestorId !== undefined &&
        requestedInvestorId !== null &&
        !validId(requestedInvestorId)
      ) {
        return jsonResponse(
          400,
          { error: "investor_id must be a positive integer." },
          origin,
        );
      }

      // Preserve existing links when a field is omitted.
      const staffId = requestedStaffId === undefined
        ? existing?.staff_id ?? null
        : requestedStaffId;

      const investorId = requestedInvestorId === undefined
        ? existing?.investor_id ?? null
        : requestedInvestorId;

      if (staffId === null && investorId === null) {
        return jsonResponse(
          400,
          { error: "Link at least one employee or investor record." },
          origin,
        );
      }

      if (staffId !== null) {
        const { data: staffRecord, error: staffError } = await supabaseAdmin
          .from("staff")
          .select("id, status, deleted_at")
          .eq("id", staffId)
          .maybeSingle();

        if (staffError || !staffRecord || staffRecord.deleted_at) {
          return jsonResponse(
            404,
            { error: "The employee record was not found or is deleted." },
            origin,
          );
        }
      }

      if (investorId !== null) {
        const { data: investorRecord, error: investorError } =
          await supabaseAdmin
            .from("investors")
            .select("id, status, deleted_at")
            .eq("id", investorId)
            .maybeSingle();

        if (
          investorError ||
          !investorRecord ||
          investorRecord.deleted_at
        ) {
          return jsonResponse(
            404,
            { error: "The investor record was not found or is deleted." },
            origin,
          );
        }
      }

      const accountPayload = {
        user_id: targetUserId,
        staff_id: staffId,
        investor_id: investorId,
        account_status: existing?.account_status ?? "active",
        updated_at: new Date().toISOString(),
      };

      const { data: saved, error: saveError } = await supabaseAdmin
        .from("personal_portal_accounts")
        .upsert(accountPayload, { onConflict: "user_id" })
        .select()
        .single();

      if (saveError || !saved) {
        console.error("Account linking failed:", saveError?.message);

        return jsonResponse(
          409,
          {
            error:
              "Unable to link this account. The employee or investor record may already belong to another portal account.",
          },
          origin,
        );
      }

      await writeAuditLog({
        actor: user.id,
        action: "PORTAL_ACCOUNT_LINKED",
        entityId: saved.id,
        before,
        after: saved,
        ipAddress: request.headers.get("x-forwarded-for"),
        deviceInfo: request.headers.get("user-agent"),
      });

      return jsonResponse(
        200,
        {
          success: true,
          message: "Personal portal account linked successfully.",
          account: saved,
        },
        origin,
      );
    }

    return jsonResponse(
      400,
      {
        error: "Unsupported action. Use list_users, link, suspend or activate.",
      },
      origin,
    );
  } catch (error) {
    console.error("Personal portal account function error:", error);

    return jsonResponse(
      500,
      {
        error: error instanceof Error
          ? error.message
          : "An unexpected server error occurred.",
      },
      origin,
    );
  }
});
