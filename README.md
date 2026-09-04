# dlr-mcp

Disneyland Resort data MCP server (stateless Streamable HTTP, JSON-RPC over POST). Deployed on Vercel as project `dlr-mcp`; endpoint `https://dlr-mcp-mattdesmondprojects.vercel.app/api/mcp`.

Tools: dlr_menu, dlr_entertainment_schedule, dlr_park_hours, dlr_entity_schedule, dlr_entity, dlr_character_catalog, dlr_wait_times, dlr_app_raw_get. All read-only.

Sources: Disney public web JSON (menus, finder schedules), Disney app backend via the anonymous public OAuth grant (park hours, per-entity schedules, character catalog), queue-times.com as a labelled fallback for wait times only.

Header gotchas: menu API needs a desktop Chrome User-Agent (else 503); finder/explorer-service needs `Accept-Language: en-US,en;q=0.9` (else SPA HTML). Per-character appearance data is scope-gated (403) and not available here.

No dependencies. Node 22. Deploy = push to main (Vercel Git integration) or deploy_to_vercel with these three files.
