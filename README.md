# Yapern web

Yapern's static Vite frontend. Accounts, profiles, boards, messages, replies,
and link metadata come from the standalone API in `../backend`.

```sh
npm ci
npm run dev       # Vite development server at http://localhost:5173
npm test          # Browser API clients, routing, rendering, and blog tests
npm run build     # Build all pages, scripts, styles, and images into dist/
npm run preview   # Preview the production build at http://localhost:4173
npm run deploy    # Build and publish the static site with Wrangler
```

Start the local API in a separate terminal:

```sh
cd ../backend
npm ci
npm run db:migrate:local
npm run dev       # http://localhost:8787
```

`src/config.js` selects `http://localhost:8787` during Vite development and
`https://api.yapern.com` for production builds, including `npm run preview`.
No environment file, Canopy project, browser API key, or development proxy is
needed. Database migrations belong to the backend repository.

The backend permits `https://yapern.com`, `https://www.yapern.com`, and
localhost/127.0.0.1 on ports 5173 and 4173. Other frontend origins must be added
to its `YAPERN_ORIGINS` configuration. API documentation is at `/docs` and
`/openapi.json` on the API server.

## Accounts and API requests

The login form at `/login/` signs in or creates an email account through
`POST /auth/email`. Session checks and sign-out use `GET` and `DELETE` on
`/auth/session`. Bearer sessions persist in localStorage for the lifetime
issued by the backend (30 days), with tab storage and memory fallbacks when
storage is blocked. Sessions are scoped to the API origin so local development,
production, and the old shared backend cannot reuse each other's logins.
Temporary network and server failures retain the session. Requests omit cookies;
passwords are sent only to the API and never saved in browser storage.

Old shared-backend accounts, credentials, sessions, and content are not moved by
copying this frontend. Transfer them separately if needed; users must sign in
to the standalone API after the cutover.

The API clients call `/tables/users`, `/tables/boards`, `/tables/messages`, and
`/tables/replies` directly. Reads use `select`, `eq.` filters, ordering, and
limit/offset pagination, with `{ "data": [...] }` responses. Writes carry the
current bearer token; the backend enforces ownership.

The shared header submits public searches to `/search/?q=...`. The search page
calls the API's `/search` endpoint and switches between messages and sub-yaps,
with relevance/newest ordering and 20 results per page. Search URLs preserve
the query, type, sort, optional board slug, and page for sharing and browser
navigation. The last query word supports prefix matching. Snippets render as
plain text. The former center navigation links are in each shared page's footer;
the search field stays visible outside the account menu on mobile. Deploy backend
migration `011_full_text_search.sql` and the API before this frontend.

The account page at `/account/` reads and updates the signed-in user's display
name and three email preferences: replies, upvotes/downvotes, and new messages
in sub-yaps they have posted or replied in. Each preference defaults to true for
existing and new accounts. Preferences use the private bearer-authenticated
`GET/PATCH /account/email-notifications` API; public author profiles stay limited
to ID and name. Event emails respect global marketing unsubscribes. Apply backend
migration `017_email_notifications.sql` and deploy the API before this frontend.

Messages and replies load current author names. Signed-in users can create
boards, edit the description of boards they created, post messages, reply, and
delete their own messages. Board descriptions can be edited from the right
sidebar on board and message pages; names and URLs stay unchanged. Deletion
requires confirmation and also removes the message's replies.

The bell opens `/notifications/` and shows a red dot for unread replies to your
messages. Notifications persist in the API database while you are away. A
per-user Durable Object sends the unread state on reconnect and pushes changes
over a hibernating WebSocket to every signed-in tab. Browser connections use
short-lived, single-use tickets rather than bearer tokens in WebSocket URLs.
The page shows real reply links and marks displayed notifications read while
visible; its ID cutoff leaves newer replies unread. Self-replies do not notify.
Deploy backend migration `010_reply_notifications.sql` and the updated Worker
before deploying this frontend.

Link previews use `POST /og-image` with `{ "url": "https://example.com" }` and
the current bearer token. The API returns final Open Graph, Twitter, favicon,
or no-image metadata. There are no screenshot jobs or preview-status polling
routes. Preview failures do not prevent posting; successful image URLs are saved
as the first line of the message body and rendered with a clickable fallback.

## Static routes and blog

The admin shell at `/backroom/` checks the stored, unexpired session locally and
allows only `oneone@gmail.com`. Users, Sub-Yaps, Messages, and Replies remain
empty. Email opens a test marketing email form with To, From, Subject, and Body.
The recipient defaults to the admin address; the editable sender defaults to
`hello@yapern.com` and must use a domain configured for email sending.
Submitting calls `POST /api/send-marketing-email` with the current bearer token
and `fancy: true` for the branded template with unsubscribe links. No API calls
run when opening the page or switching sections. The backend enforces admin
authorization and recipient opt-outs. The form prevents concurrent submissions,
preserves the draft, and never retries a send automatically. Success confirms
provider acceptance, not inbox delivery. Deploy backend migration `015` and
configure its email binding and sender domain before live sends.

The about page at `/about/` uses the blog article layout to explain Yapern’s
aim to build a better Reddit in the open, its current state, and how to contribute.

All messages use `/all`, board links use `/y/:slug`, and message links use
`/y/:slug/:id`. These routes load `board.html` and fetch data in the browser.
`public/_redirects` rewrites `/all`, `/all/`, and `/y/*` to `/board` with a 200
response. Vite development and preview apply the same rewrite. Other static
hosts need equivalent rules. The all-messages feed shows 20
messages per page ordered by votes descending, with newest messages first for
vote ties; pages at `/all?page=2` and onward continue through lower-ranked
messages. The homepage shows the top three messages using the same ordering.
Deploy the API's message vote ordering support before this frontend; no new
database migration is required.

The homepage and board pages share board navigation, message lists, and recent
posts. These load independently and provide inline loading, empty, unavailable,
and retry states. Layouts adapt to tablet and phone widths.

The blog at `/blog/` renders at development/build time, with six articles per
page and older pages at `/blog/page/2/` and onward. Add metadata in `src/blog.js`,
create `blog/<slug>/index.html`, register it in `vite.config.js`, and add the URL
to `public/sitemap.xml`. Article media lives in `public/images/blog/<slug>/`.
Historical articles describe the architecture at the time they were written.

Wrangler publishes `dist/` as static assets, with a small `worker.js` that runs
before assets only for `/y/*`. On sub-yap pages (`/y/:slug`, with or without a
trailing slash), it injects the current name, description, canonical URL, and
Open Graph/Twitter metadata into the shared HTML. Images use the sub-yap logo
or the homepage's Yapern logo when none is set. Public board lookups have a
60-second edge cache and a two-second timeout; failures keep the page available
with basic metadata and the Yapern logo. Message pages and other routes retain
their static behavior. No per-sub-yap pages are generated at build time.

Run `npm run build` before previewing or deploying. Vite development renders
dynamic metadata using the local API at `http://localhost:8787`; Vite preview
uses the production API, matching the built browser clients. Use
`npx wrangler dev --port 8788` to test
dynamic metadata locally against the production API, or add
`--var API_ORIGIN:http://localhost:8787` to use the local backend. Use
`npx wrangler deploy --dry-run` to validate deployment without publishing.
