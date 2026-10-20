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

The account page at `/account/` reads and updates the signed-in user's display
name. Messages and replies load current author names. Signed-in users can create
boards, edit the description of boards they created, post messages, reply, and
delete their own messages. Board descriptions can be edited from the right
sidebar on board and message pages; names and URLs stay unchanged. Deletion
requires confirmation and also removes the message's replies.

Link previews use `POST /og-image` with `{ "url": "https://example.com" }` and
the current bearer token. The API returns final Open Graph, Twitter, favicon,
or no-image metadata. There are no screenshot jobs or preview-status polling
routes. Preview failures do not prevent posting; successful image URLs are saved
as the first line of the message body and rendered with a clickable fallback.

## Static routes and blog

The about page at `/about/` uses the blog article layout to explain Yapern’s
aim to build a better Reddit in the open, its current state, and how to contribute.

All messages use `/all`, board links use `/y/:slug`, and message links use
`/y/:slug/:id`. These routes load `board.html` and fetch data in the browser.
`public/_redirects` rewrites `/all`, `/all/`, and `/y/*` to `/board` with a 200
response. Vite development and preview apply the same rewrite. Other static
hosts need equivalent rules; there is no SSR. The all-messages feed shows 20
messages per page with older pages at `/all?page=2` and onward; the homepage
shows the latest three messages.

The homepage and board pages share board navigation, message lists, and recent
posts. These load independently and provide inline loading, empty, unavailable,
and retry states. Layouts adapt to tablet and phone widths.

The blog at `/blog/` renders at development/build time, with six articles per
page and older pages at `/blog/page/2/` and onward. Add metadata in `src/blog.js`,
create `blog/<slug>/index.html`, register it in `vite.config.js`, and add the URL
to `public/sitemap.xml`. Article media lives in `public/images/blog/<slug>/`.
Historical articles describe the architecture at the time they were written.

Wrangler publishes `dist/` as static assets only, without a frontend API Worker.
Run `npm run build` before previewing or deploying. Use
`npx wrangler deploy --dry-run` to validate deployment without publishing.
