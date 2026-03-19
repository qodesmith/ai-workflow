I want to build a bookmark manager. Users can save URLs with a title, and they show up in a list. If they try to save the same URL twice it should tell them it's already saved. They can delete bookmarks and the list updates without reloading the page. I also want search — they type in the search box and results filter in real time as they type.

Bookmarks should be organizable into folders. You drag a bookmark into a folder and it moves there. The folder shows how many bookmarks are in it.

For the technical side — I want a normalized database schema, separate tables for bookmarks and folders. React Query for state management on the frontend, no Redux or anything like that. REST API, nothing fancy. I'm thinking react-hot-toast for the toast notifications. The search should be debounced so we're not hitting the API on every keystroke.

This is a Next.js app with Drizzle ORM and PostgreSQL. Auth is already set up with NextAuth.
