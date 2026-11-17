
/**
 * STARLINK ULTRANET
 * Function: starlink-id-login
 *
 * Allows users to sign in using their STARLINK ID and password.
 *
 * IMPORTANT:
 * - Secret keys are used only on the server.
 * - Password verification is handled by Supabase Auth.
 * - Never log or return passwords or profile email addresses.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");

function readKey(
    jsonVariable: string,
    legacyVariable: string
): string | null {
    const jsonValue = Deno.env.get(jsonVariable);

    if (jsonValue) {
        try {
            const parsed = JSON.parse(jsonValue);
            return parsed.default ?? null;
        } catch {
            return null;
        }
    }

    return Deno.env.get(legacyVariable) ?? null;
}

const SECRET_KEY = readKey(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY"
);

const PUBLISHABLE_KEY = readKey(
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_ANON_KEY"
);

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

function getCorsHeaders(origin: string | null): HeadersInit {
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

function respond(
    body: Record<string, unknown>,
    status: number,
    origin: string | null
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...getCorsHeaders(origin),
            "Content-Type": "application/json"
        }
    });
}

Deno.serve(async (request: Request) => {
    const origin = request.headers.get("origin");

    // Handle browser CORS preflight.
    if (request.method === "OPTIONS") {
        if (origin && !allowedOrigins.includes(origin)) {
            return new Response("Origin not allowed", { status: 403 });
        }

        return new Response("ok", {
            headers: getCorsHeaders(origin)
        });
    }

    if (origin && !allowedOrigins.includes(origin)) {
        return respond({ error: "Request not allowed." }, 403, origin);
    }

    if (request.method !== "POST") {
        return respond({ error: "Method not allowed." }, 405, origin);
    }

    if (!SUPABASE_URL || !SECRET_KEY || !PUBLISHABLE_KEY) {
        console.error("Required Supabase environment variables are missing.");
        return respond(
            { error: "Login service is temporarily unavailable." },
            500,
            origin
        );
    }

    try {
        const body = await request.json();

        const starlinkId =
            typeof body.starlink_id === "string"
                ? body.starlink_id.trim().toUpperCase()
                : "";

        const password =
            typeof body.password === "string"
                ? body.password
                : "";

        if (
            !starlinkId ||
            !password ||
            starlinkId.length > 100 ||
            password.length > 256
        ) {
            return respond(
                { error: "Invalid login details." },
                400,
                origin
            );
        }

        /*
         * STEP 1:
         * Find the profile using its STARLINK ID.
         *
         * IDs are normalized to uppercase before lookup.
         * Store assigned STARLINK IDs in uppercase as well.
         *
         * The secret key is sent only in the apikey header.
         */
        const profileUrl = new URL(
            `${SUPABASE_URL}/rest/v1/profiles`
        );

        profileUrl.searchParams.set("select", "email");
        profileUrl.searchParams.set("starlink_id", `eq.${starlinkId}`);
        profileUrl.searchParams.set("limit", "2");

        const profileResponse = await fetch(profileUrl.toString(), {
            method: "GET",
            headers: {
                "apikey": SECRET_KEY
            }
        });

        if (!profileResponse.ok) {
            console.error(
                "STARLINK profile lookup failed:",
                profileResponse.status
            );

            return respond(
                { error: "Unable to sign in." },
                401,
                origin
            );
        }

        const profiles = await profileResponse.json();

        // Require exactly one matching profile.
        if (
            !Array.isArray(profiles) ||
            profiles.length !== 1 ||
            typeof profiles[0].email !== "string" ||
            !profiles[0].email
        ) {
            return respond(
                { error: "Invalid login details." },
                401,
                origin
            );
        }

        const email = profiles[0].email;

        /*
         * STEP 2:
         * Verify the password using Supabase Auth.
         *
         * Supabase Auth handles password verification.
         * This function never stores the supplied password.
         */
        const authResponse = await fetch(
            `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "apikey": PUBLISHABLE_KEY
                },
                body: JSON.stringify({
                    email,
                    password
                })
            }
        );

        const authData = await authResponse.json();

        if (
            !authResponse.ok ||
            !authData.access_token ||
            !authData.refresh_token
        ) {
            return respond(
                { error: "Invalid login details." },
                401,
                origin
            );
        }

        /*
         * STEP 3:
         * Return the session tokens to the frontend.
         * The frontend will call supabase.auth.setSession().
         */
        return respond(
            {
                access_token: authData.access_token,
                refresh_token: authData.refresh_token
            },
            200,
            origin
        );

    } catch (error) {
        console.error(
            "STARLINK ID login function error:",
            error instanceof Error ? error.message : "Unknown error"
        );

        return respond(
            { error: "Unable to process login at this time." },
            500,
            origin
        );
    }
});
