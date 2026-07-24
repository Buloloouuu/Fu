# Runs the exact same main.ts as the Deno Deploy instance, as a Render
# Web Service. Render doesn't have a native Deno runtime, so this uses
# Deno's own Docker image directly — no code fork needed.
#
# Deploy: create a new Render Web Service, pick "Docker" as the
# environment, and point it at the directory containing this Dockerfile
# (with main.ts one level up, or copy main.ts alongside this Dockerfile —
# adjust the COPY path below to match your repo layout).
#
# IMPORTANT: do NOT set OUTBOUND_LIMIT_GBITS on this deployment. Its
# absence is what tells main.ts "just do the work directly, don't check
# a budget or forward anywhere" — that's what makes this the fallback
# rather than another thing that could itself try to forward somewhere.
#
# Required env vars on this Render service (same meaning as on Deno):
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
#   SHARED_SECRET        — should match RENDER_SHARED_SECRET set on the
#                          Deno Deploy instance, so this service only
#                          accepts forwarded requests from it.
# Render injects PORT automatically; main.ts already reads it via
# Deno.env.get("PORT").

FROM denoland/deno:2.1.4

WORKDIR /app

# Adjust this path if main.ts lives elsewhere in your repo.
COPY main.ts .

# Cache remote deps (aws4fetch) at build time rather than on first request.
RUN deno cache main.ts

EXPOSE 10000

CMD ["deno", "run", "--allow-net", "--allow-env", "main.ts"]
