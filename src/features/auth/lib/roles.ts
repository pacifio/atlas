import type { ComponentProps } from "react";
import type { Tag } from "@tryatlas/design";

/**
 * Organisation roles (API doc §6) and how the screen shows them. Pure, so a
 * view can read them: a view may not import an `*-api` module, not even for a
 * type, so `auth-api.ts` re-exports `Role` from here rather than owning it.
 */
export type Role = "admin" | "product_owner" | "developer" | "member";

/** Highest privilege first. */
export const ROLES: readonly Role[] = ["admin", "product_owner", "developer", "member"];

/** What each role is called on screen. Matches the web dashboard's wording. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  product_owner: "Product Owner",
  developer: "Developer",
  member: "Member",
};

type Hue = NonNullable<ComponentProps<typeof Tag>["hue"]>;

/** Each role's identity hue on its tag — the web members table's mapping,
 *  on the package's palette (it has no indigo; blue stands in). */
export const ROLE_HUE: Record<Role, Hue> = {
  admin: "purple",
  product_owner: "blue",
  developer: "cyan",
  member: "grey",
};
