import { KitApp } from "@/components/KitApp";

/**
 * Deep links. KitApp routes in React state, so every in-app path (`/account/<id>`,
 * `/deploy/grid`, `/agent/<id>`, ...) must resolve to the same shell or a
 * reload / shared link lands on Next's 404. `app/api/**` route handlers are
 * more specific than this catch-all and keep precedence.
 */
export default function Page() {
  return <KitApp />;
}
