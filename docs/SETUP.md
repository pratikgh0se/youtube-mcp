# Beginner setup guide

From zero to a working YouTube MCP install in about 15 minutes. No Google Cloud experience needed.

Google changes its console screens now and then. Where a button label below might differ slightly on your screen, the step says what to look for instead of an exact label.

## 1. What you get and what you need

Pick a path. You can start with A and add B later.

| | Path A: public research | Path B: your channel too |
| --- | --- | --- |
| Time | about 5 minutes | about 15 minutes |
| You can | Search videos, read video and channel info, public comments, public transcripts | Everything in A, plus your playlists, uploads, thumbnails, captions, comments and analytics |
| You need | A Google account, an **API key** | API key, **OAuth client** (Desktop app), your **channel ID**, a one-time browser sign-in |
| Steps | 2, 3, 4, then 9 and 10 | All steps 2 to 10 |

**Cost: free.** You do not need to add a billing account. The limit is a daily quota, not money (see [section 11](#11-limits-to-know)).

You also need Node.js 22 or newer (`node --version` to check).

Every change to your YouTube account is previewed and needs your approval first. Nothing happens by surprise.

## 2. Create a Google Cloud project

A project is the container for your keys and settings.

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and sign in with the Google account you want to use. Accept any first-time terms screen.
2. Click the project picker at the top of the page, then **New project**.
3. Name it something like `youtube-mcp` and click **Create**.
4. Make sure the new project is selected in the project picker before you continue.

If Google offers to add billing, you can skip it. Google's project-creation page does not list billing as a requirement.

## 3. Enable the two APIs

1. In the console menu, open **APIs & Services**, then **Library**.
2. Search for **YouTube Data API v3**, open it and click **Enable**.
3. Go back to the Library, search for **YouTube Analytics API**, open it and click **Enable**.

Skip the YouTube Reporting API. This server does not need it. If you only want Path A you can skip the Analytics API, but enabling it now costs nothing.

## 4. Create and restrict the API key

1. Open **APIs & Services**, then **Credentials**.
2. Click **Create credentials**, then **API key**.
3. If the form has a checkbox like "Authenticate API calls through a service account", leave it **unticked**. That option makes a different kind of key that this server does not use.
4. Restrict the key to one API: under API restrictions choose **Restrict key**, tick **YouTube Data API v3**, and save.
5. Copy the key and keep it somewhere private (see [section 9](#9-put-the-values-into-your-ai-agent)).

An API key only reads public data. Anything about your own channel uses the OAuth steps below.

> **Keep the key secret.** Do not commit it to git, paste it into an issue, a public chat or a screenshot. If it leaks, delete it in **Credentials** and create a new one.

Path A stops here. Jump to [section 9](#9-put-the-values-into-your-ai-agent).

## 5. OAuth consent screen

**Why this exists:** to act on your channel, the server has to ask Google for permission as you. Google requires every app that does this to have a consent screen. Here the app is just your own private project.

1. Open **APIs & Services**, then **OAuth consent screen**. Google now calls this area **Google Auth Platform**, and may show a **Get started** button. Click it.
2. Fill in the wizard:
   - **App name**: anything, for example `youtube-mcp`.
   - **User support email**: your Gmail address.
   - **Audience**: choose **External**. (Internal is only for Google Workspace organisations.)
   - **Contact information**: your email address.
3. Agree to the policy checkbox and click **Create**.
4. Open **Audience** in the left menu. Make sure the publishing status is **Testing**.
5. Under **Test users**, click **Add users**, enter **your own Gmail address** (the one that owns your YouTube channel) and save.

What to know about Testing mode:

| Fact | What it means for you |
| --- | --- |
| Testing mode is fine for personal use | You never need to publish or get Google to review anything |
| Up to 100 test users | Plenty for yourself and a few friends |
| Sign-in expires after 7 days | Re-run `youtube-auth` about once a week ([section 8](#8-sign-in-once)) |
| "Google hasn't verified this app" warning | Expected. It is your own app. You will click through it in section 8 |

Sources: [Google Cloud help, app audience](https://support.google.com/cloud/answer/15549945), [OAuth token expiry](https://developers.google.com/identity/protocols/oauth2#expiration).

## 6. Create the Desktop OAuth client

1. Open **Google Auth Platform**, then **Clients** (or **APIs & Services**, **Credentials**).
2. Click **Create client** (or **Create credentials**, **OAuth client ID**).
3. Application type: **Desktop app**. Name it anything, then click **Create**.
4. Click the **Download JSON** button (a download icon) and save the file.
5. Move it somewhere private and lock it down. On macOS or Linux:

```bash
mkdir -p ~/.config/youtube-mcp
mv ~/Downloads/client_secret_*.json ~/.config/youtube-mcp/client_secret.json
chmod 600 ~/.config/youtube-mcp/client_secret.json
```

You will use the **absolute** path to this file later, for example `/Users/you/.config/youtube-mcp/client_secret.json`. Google's docs suggest the client secret may only be shown once, so download the JSON right away.

> **Keep this file secret** too. It identifies your app to Google.

## 7. Find your channel ID

1. Make sure your Google account has a YouTube channel. A brand-new Google account has none: go to [youtube.com](https://www.youtube.com/), click your profile picture, and follow the prompts to create a channel first.
2. Open [youtube.com/account_advanced](https://www.youtube.com/account_advanced) while signed in as the channel's owner.
3. Copy the **Channel ID**. It starts with `UC`.

Also pick a **profile name**: any short label you like, for example `creator-main`. It keeps local data separate if you ever use more than one channel.

## 8. Sign in once

Run this in a terminal, using your own paths and values:

```bash
YOUTUBE_OAUTH_CLIENT_SECRET_FILE=/absolute/path/to/client_secret.json \
YOUTUBE_MCP_PROFILE_ID=creator-main \
npx -y github:pratikgh0se/youtube-mcp#v0.2.0 youtube-auth
```

The first run downloads and builds the server, which takes about a minute.

What you will see:

1. Your browser opens a Google sign-in page. Choose the account that owns the channel.
2. A warning: **Google hasn't verified this app**. This is expected for your own app. Click **Advanced** (if shown), then **Continue** or **Go to your app (unsafe)**.
3. A permissions page. **Tick all the permissions** and click **Continue**. If you leave any unticked, some tools will ask you to sign in again.
4. The terminal prints a line like `{"authorized":true, ...}`. That is success. You can close the browser tab.

The server asks for three permissions: manage your YouTube account (`youtube`), see, edit and delete your YouTube videos, ratings, comments and captions (`youtube.force-ssl`), and view your YouTube Analytics reports (`yt-analytics.readonly`). The sign-in uses a temporary local address on `127.0.0.1` to receive Google's reply.

**Where the token goes:** under `~/.youtube-mcp/profiles/<profile name>/oauth-token.json`, readable only by you. Set `YOUTUBE_MCP_STATE_DIR` to change the base folder.

> **Use the same values everywhere.** If you set `YOUTUBE_MCP_PROFILE_ID` or `YOUTUBE_MCP_STATE_DIR` here, give the **exact same** values to your AI agent. The server looks for the token in the location those two settings point to. A different profile name or state directory means it will not find your sign-in.

## 9. Put the values into your AI agent

| What you have | Environment variable | Needed for | Example |
| --- | --- | --- | --- |
| API key | `YOUTUBE_API_KEY` | Everything (required) | `AIza...` |
| OAuth client JSON path | `YOUTUBE_OAUTH_CLIENT_SECRET_FILE` | Your channel (Path B) | `/Users/you/.config/youtube-mcp/client_secret.json` |
| Profile name | `YOUTUBE_MCP_PROFILE_ID` | Your channel (Path B) | `creator-main` |
| Channel ID | `YOUTUBE_MCP_CHANNEL_ID` | Your channel (Path B) | `UCxxxxxxxxxxxxxxxxxxxxxx` |
| State folder | `YOUTUBE_MCP_STATE_DIR` | Optional | leave blank for `~/.youtube-mcp` |

Use **absolute paths** (starting with `/`, or `C:\` on Windows). A `~` may not be expanded by your agent.

Each agent has its own file format. Pick yours in [Install in your AI agent](../README.md#install-in-your-ai-agent) in the README.

**Claude Code:**

- The plugin install dialog asks for these values. The API key goes to your OS credential store.
- To change them later, run `/plugin`, pick the youtube-mcp plugin and choose configure. Or do it without prompts by sending a JSON object on stdin. The keys are the env var names; settings you leave out keep their values:

```bash
echo '{"YOUTUBE_OAUTH_CLIENT_SECRET_FILE":"/Users/you/.config/youtube-mcp/client_secret.json","YOUTUBE_MCP_PROFILE_ID":"creator-main","YOUTUBE_MCP_CHANNEL_ID":"UC...","YOUTUBE_MCP_STATE_DIR":"/Users/you/.youtube-mcp"}' \
  | claude plugin configure youtube-mcp@youtube-mcp --values-stdin
claude plugin configure youtube-mcp@youtube-mcp   # lists each setting as set / not set
```

- Then run `/reload-plugins`.

**Keep secrets out of chat.** Do not type your API key into a conversation with the agent. Keep your values in a private env file and read from there:

```bash
# ~/.config/youtube-mcp/env   (then: chmod 600 ~/.config/youtube-mcp/env)
YOUTUBE_API_KEY=your-key
YOUTUBE_OAUTH_CLIENT_SECRET_FILE=/Users/you/.config/youtube-mcp/client_secret.json
YOUTUBE_MCP_PROFILE_ID=creator-main
YOUTUBE_MCP_CHANNEL_ID=UC...
```

An empty value counts as unset.

## 10. Check it works

Ask your agent:

> Check my YouTube auth status.

For Path B you should see `authorized` set to `true` and your channel. Then try a real request, such as "Show my channel's top videos for the last 90 days".

For Path A, `authorized` stays `false` and that is fine. Ask "Search YouTube for recent talks about the Model Context Protocol". A public search needs only the API key.

## 11. Limits to know

**Quota.** Google gives each project **10,000 units per day** by default. The counter resets at **midnight Pacific Time**. Since June 2026, uploads (`videos.insert`) and searches (`search.list`) each have their own separate bucket of **100 calls per day**, outside the shared pool ([Google quota docs](https://developers.google.com/youtube/v3/determine_quota_cost), [revision history](https://developers.google.com/youtube/v3/revision_history)).

| Operation | Cost in units |
| --- | --- |
| Search (`search.list`) | 1 (own bucket, 100 calls/day) |
| Get video, list comments, list subscriptions | 1 |
| Upload video (`videos.insert`) | 1 (own bucket, 100 calls/day) |
| Update video metadata, rate video, set thumbnail | 50 |
| List caption tracks, delete caption | 50 |
| Upload caption | 400 |
| Update caption | 450 |
| Create, update or delete a playlist or playlist item | 50 |
| Post, reply to, delete or moderate a comment | 50 |
| Subscribe or unsubscribe | 50 |

Caption download cost is not listed on Google's page.

**Uploads from new projects.** Google's revision history says videos uploaded through the API from unverified projects created after July 28, 2020 may be locked to private until the project passes an audit. Google's `videos.insert` reference says the opposite. Treat public uploads as possibly unavailable until you have checked on your own project.

<!-- E2E: confirm private-lock behaviour -->

This server uploads as private by default, so the lock does not block normal use.

**Other limits:**

- **Custom thumbnails** need a phone-verified channel. Verify at [youtube.com/verify](https://www.youtube.com/verify).
- **No delete-video tool.** Delete videos yourself in YouTube Studio.
- **Analytics lag about 2 days**, and a new channel shows zeros until it has data.
- **Comments are disabled** on private videos and videos made for kids, so you cannot comment on them.

## 12. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `auth_status` shows `not_configured` | `YOUTUBE_OAUTH_CLIENT_SECRET_FILE` is empty or points at the wrong place | Set it to the absolute path of the downloaded JSON and reload the agent |
| `ownership_required` | The channel ID does not match the account you signed in with, or YouTube has not caught up after you just created something | Check `YOUTUBE_MCP_CHANNEL_ID` against [youtube.com/account_advanced](https://www.youtube.com/account_advanced). If you just created the item, wait a moment and retry |
| `quotaExceeded` | You used the day's quota | Wait until midnight Pacific Time, or request more via the [audit and quota form](https://support.google.com/youtube/contact/yt_api_form) |
| `invalid_grant`, token expired, or "reauthorization required" | In Testing mode the sign-in expires after 7 days. Or you revoked access | Run the `youtube-auth` command from section 8 again |
| "Access blocked" or "not a test user" | Your Gmail is not on the test users list | Go to **Google Auth Platform**, **Audience**, **Test users**, add your address, and sign in again |
| Claude Code shows the server failed or timed out on first install | The first `npx` run downloads and builds, and can take longer than 30 seconds | Run `npx -y github:pratikgh0se/youtube-mcp#v0.2.0 --version` once in a terminal to warm the cache, then `/reload-plugins` |
| Sign-in works but tools say no token | `YOUTUBE_MCP_PROFILE_ID` or `YOUTUBE_MCP_STATE_DIR` differs between the sign-in and the agent | Use identical values in both ([section 8](#8-sign-in-once)) |
| API key errors, "API not enabled", or "key not valid" | The API is not enabled in this project, or the key is restricted to a different API | Check section 3 and that the key's API restriction includes **YouTube Data API v3** |

## 13. Going to production

Testing mode is enough for personal use. Moving the consent screen to **In production** with the YouTube permissions requires Google to review and verify your app. Separately, the [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form) is how you ask for higher quota and, per Google, to lift restrictions on public uploads. Most people never need either.

## 14. Security notes

- The **API key** and the **client JSON** are secrets. Do not commit, share or screenshot them.
- The server sends your credentials only to Google's APIs.
- The sign-in token is stored in your state folder (default `~/.youtube-mcp`), in a file only you can read.
- To **revoke access**, open [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and remove the app. Run `youtube-auth` again if you want to reconnect. You can also delete the API key and OAuth client in the Cloud console.

---

Checked 2026-10-28. Main sources: [Google Cloud project setup](https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects), [API keys](https://docs.cloud.google.com/docs/authentication/api-keys), [app audience and test users](https://support.google.com/cloud/answer/15549945), [OAuth expiry rules](https://developers.google.com/identity/protocols/oauth2#expiration), [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost), [YouTube API revision history](https://developers.google.com/youtube/v3/revision_history), [finding your channel ID](https://support.google.com/youtube/answer/3250431), [custom thumbnails](https://support.google.com/youtube/answer/72431).
