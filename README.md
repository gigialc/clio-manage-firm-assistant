# Clio Manage Firm Assistant

A private, hosted connection between Clio Manage and ChatGPT/Codex. This first release is deliberately **read-only**. It can:

- confirm which Clio user is connected;
- list active Clio users and visible calendars;
- review calendar availability, hiding event names as **Busy** by default; and
- review tasks by status, due date, or assignee.

Every lawyer connects with their own Clio account. The assistant can only see records that Clio already allows that person to see.

## The simple setup

You do this once as the administrator. Lawyers do not run a script and do not receive the Client Secret.

### 1. Put this folder in a private GitHub repository

Create a private repository, upload the contents of this folder, and make sure `render.yaml` is at the top level of the repository.

Do **not** upload a `.env` file or paste the Clio Client Secret into any document, email, or chat.

### 2. Copy the two Clio app values

Open [Clio app 37994](https://developers.clio.com/apps/37994) while signed into the firm's Clio developer account.

Copy these values somewhere temporarily and securely:

- **Client ID**
- **Client Secret**

For permissions, select the minimum read-only access needed for:

- users;
- calendars and calendar entries; and
- tasks.

If Clio groups permissions by resource, choose **Read** for those resources only. Leave **Write**, **Create**, and **Delete** off. Changes to an app's permissions may require users to reconnect it.

### 3. Deploy it on Render

1. Sign in to [Render](https://dashboard.render.com/).
2. Choose **New → Blueprint**.
3. Connect the private GitHub repository from step 1.
4. Render will find `render.yaml` and create the web service and private database.
5. When prompted, paste the Clio **Client ID** and **Client Secret** into Render's secret fields.
6. Choose **Apply** and wait for the deployment to finish.

The included Blueprint uses an always-on Starter web service and a small PostgreSQL database. Confirm Render's current price before approving the deployment.

### 4. Add the exact Clio redirect address

Render gives the service a URL similar to:

`https://clio-manage-mcp.onrender.com`

Open the deployed service's **Setup Status** page by adding `/setup-status`:

`https://YOUR-SERVICE.onrender.com/setup-status`

Copy the value beside `clio_redirect_uri`. It will look like:

`https://YOUR-SERVICE.onrender.com/oauth/clio/callback`

Return to [Clio app 37994](https://developers.clio.com/apps/37994), paste that full value into the app's **Redirect URI** field, and save it. It must match exactly, including `https://` and `/oauth/clio/callback`.

Refresh `/setup-status`. It should say:

```json
{"ready":true}
```

### 5. Connect the hosted app to ChatGPT

1. In ChatGPT, open **Settings → Apps → Advanced settings**.
2. Turn on **Developer mode**.
3. Choose **Create app**.
4. Enter a name such as **Clio Manage Firm Assistant**.
5. For the MCP server URL, enter:

   `https://YOUR-SERVICE.onrender.com/mcp`

6. Save it and choose **Connect**.
7. A Clio sign-in page will open. Sign in and approve access.

After ChatGPT creates the app, copy its technical ID. It begins with `plugin_asdk_app`. That ID is used to finish the installable Codex plugin package.

## What each lawyer does

1. Install the firm's Clio Manage plugin using the link supplied by the administrator.
2. Select **Connect** when ChatGPT asks for Clio access.
3. Sign into their own Clio account and approve access.

No terminal, script, Client ID, Client Secret, or app restart is required. The hosted connection works in a supported browser and in the ChatGPT desktop app.

## Safe test questions

- “Which Clio user am I connected as?”
- “Show the firm's visible calendars.”
- “Who appears free tomorrow between 2:00 and 4:00 PM? Keep event names private.”
- “Show my pending Clio tasks due this week.”

## Administrator notes

- The app encrypts stored Clio credentials and stores them in PostgreSQL.
- The `TOKEN_ENCRYPTION_KEY` is created automatically by the Render Blueprint.
- Never change or delete that key while people are connected; doing so makes their saved connections unreadable.
- To disconnect access, remove the app in ChatGPT and revoke it in Clio.
- This release does not create, edit, or delete Clio records.

## Local developer checks

These steps are only for the person maintaining the app:

```bash
npm install
npm run typecheck
npm test
npm run build
```

For local development, copy `.env.example` to `.env`, use test credentials, and run `npm run dev`. Never use production legal-client data in a developer environment.
