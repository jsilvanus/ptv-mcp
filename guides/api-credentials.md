# Getting PTV API credentials for this MCP

To read and write PTV data, this MCP needs PTV API credentials for each
PTV environment (`test`, `production`). A **Tenant Admin** enters them in
the MCP web UI under **PTV connections**. They are stored
envelope-encrypted and never shown again.

## Status (2026-09-24)

| API version           | Status in this MCP                                    | How to get credentials                                                                                                                           |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **v12** (current API) | Read supported; writing not yet enabled in this MCP   | **Not yet published by DVV.** Instructions are expected in about a month (around late October 2026). This guide will be updated then.       |
| **v11** (legacy API)  | Supported for reading and writing, being retired      | **Intentionally not documented here.** DVV is deprecating v11, so new organisations should not start on it. Existing v11 users: ask your PTV main user or ptv-tuki@dvv.fi. |

## What is already known (applies regardless of version)

These steps come from DVV's current IN API guidance ("Näin otan
IN-rajapinnan käyttöön"). The details may change for v12.

1. **The organisation must have a PTV permit.** See the `getting-started`
   guide.
2. **Machine writes (the IN API) need their own permit.** A **PTV main
   user** applies in Suomi.fi-palveluhallinta: dashboard →
   Palvelutietovaranto → *Hae käyttölupaa*. In a new permit application,
   fill in Part 2, which describes the connecting system and its security.
   Name this MCP (and its operator, if a supplier runs it) as the
   connecting system, with a technical contact person.
3. **Processing takes about 1–2 weeks.**
4. For the production environment, DVV has so far required a **test phase**
   first. The integration's content is tested in the PTV test
   environment, the PTV main user checks the content quality and sends a
   test report to ptv-tuki@dvv.fi, and DVV then issues **production API
   credentials**. Expect several rounds.
5. DVV sends the credentials to the address given in the application.
   **Treat them as secrets.** Enter them only in this MCP's PTV connections
   page. Never paste them into a chat with an AI assistant, an email or a
   ticket.

## Entering a v12 API key in the MCP (for when you have one)

1. Log in to the MCP web UI as a **Tenant Admin** of the tenant.
2. Open **PTV connections** → *Connect a PTV v12 API key*.
3. Choose the environment (`test` first) and paste the key.
4. The key is stored encrypted and the change is recorded in the audit log.
   Replacing a key is audited too. Use the connection test button to check
   that PTV accepts the key.

## Rules for the AI assistant

- Never ask the user for API keys, passwords or tokens, and never repeat
  them back. Point the user to the PTV connections page instead.
- If a tool fails with an adapter or credential error, explain which
  environment and API version is missing credentials and who can fix it
  (a Tenant Admin). Don't try to work around it.
