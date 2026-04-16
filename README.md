# Form Inbox — Framer Webhook Receiver

A self-hosted webhook receiver and submissions dashboard for Framer form submissions. Stores all form data in a local SQLite database and provides a clean, searchable dashboard UI.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

The webhook endpoint is available at `http://localhost:3000/webhook`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `WEBHOOK_SECRET` | *(none)* | Optional secret token. If set, all webhook requests must include a matching `X-Webhook-Token` header. Leave empty for easy local testing. |

Copy `.env.example` to `.env` and edit as needed.

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/webhook` | Receive a form submission |
| `GET` | `/api/submissions` | List all submissions (newest first) |
| `GET` | `/api/submissions/:id` | Get a single submission |
| `DELETE` | `/api/submissions/:id` | Delete a submission |

## Connecting Framer Forms

1. **Open your Framer project** and select the form component on your page.

2. **Open Form Settings** — click the form, then look for the settings panel on the right side.

3. **Set the Action to "Send to URL"**:
   - In the form settings, find the **"Submit"** or **"Action"** dropdown.
   - Select **"Send to URL"** (sometimes labeled "Custom URL" or "Webhook").

4. **Paste your webhook URL**:
   ```
   https://your-deployed-url.railway.app/webhook
   ```
   For local testing, use `http://localhost:3000/webhook`.

5. **If using a webhook secret**, add a custom header in Framer's form settings (if supported), or handle it in your Framer custom code:
   ```
   X-Webhook-Token: your-secret-here
   ```

6. **Test it** — submit the form and check the dashboard. Your submission should appear within seconds.

### Using Framer Custom Code (Advanced)

If you need more control, you can use Framer's Custom Code override to send form data manually:

```js
// In Framer: Add a Code Override to your form's submit button
export function withWebhook(Component) {
  return (props) => {
    return (
      <Component
        {...props}
        onSubmit={async (e) => {
          e.preventDefault()
          const formData = new FormData(e.target)
          const data = Object.fromEntries(formData.entries())

          await fetch("https://your-deployed-url.railway.app/webhook", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          })
        }}
      />
    )
  }
}
```

## Deploy to Railway

1. Push this project to a GitHub repository.
2. Go to [railway.app](https://railway.app) and create a new project.
3. Select **"Deploy from GitHub repo"** and pick your repository.
4. Railway will auto-detect the `Procfile` and deploy.
5. Optionally set `WEBHOOK_SECRET` in Railway's environment variables.
6. Copy the generated Railway URL and paste it into your Framer form settings.

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: SQLite via better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
