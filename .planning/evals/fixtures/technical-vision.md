# Technical Vision

## Engineer-Specified Intent

### Data model: bookmarks

**Intent:** Bookmarks are stored in a `bookmarks` table with columns: `id` (UUID, PK), `user_id` (FK to users), `url` (text, unique per user), `title` (text), `folder_id` (nullable FK to folders), `created_at` (timestamp). Folders are stored in a separate `folders` table with `id` (UUID, PK), `user_id` (FK to users), `name` (text), `created_at` (timestamp). A bookmark with `folder_id = null` lives at the top level.

**Affects scenarios:** SC-01, SC-02, SC-03, SC-05

**Notes:** The uniqueness constraint on URL is scoped to the user — two different users can bookmark the same URL.

### Frontend state management

**Intent:** Use React Query for server state. Bookmark list, search results, and folder contents are all queries that invalidate on mutation. No client-side state store — the server is the source of truth and React Query's cache handles optimistic updates for delete and move operations.

**Affects scenarios:** SC-01, SC-02, SC-03, SC-04, SC-05

**Notes:** Search (SC-04) should debounce the query by 300ms to avoid excessive API calls while typing.

### API design

**Intent:** REST API with the following endpoints: `POST /api/bookmarks` (create), `DELETE /api/bookmarks/:id` (delete), `GET /api/bookmarks?q=searchterm` (list/search), `PATCH /api/bookmarks/:id` (move to folder). All endpoints require authentication via session cookie.

**Affects scenarios:** SC-01, SC-02, SC-03, SC-04, SC-05

**Notes:** The GET endpoint handles both listing and searching — if `q` is absent, return all bookmarks; if present, filter by title.

---

## Deferred Areas

- **Toast notification system** — implied by SC-01, SC-02. No opinion on implementation — could be a library or custom component.
- **Folder CRUD** — implied by SC-05. No opinion on the UI for creating/deleting folders.

---

## Tensions

- **React Query optimistic updates** vs. **SC-03:** Optimistic delete removes the bookmark from the UI immediately, but if the server request fails, it reappears. SC-03 says "the bookmark disappears from the list" — does the scenario need to account for the rollback case?
