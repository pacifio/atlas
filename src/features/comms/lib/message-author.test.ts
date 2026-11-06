import { describe, expect, it } from "vitest";

import { authorLabel, isWebhookMessage, presentAuthor } from "./message-author";

const person = (id: string) => (id === "u_ada" ? "Ada Lovelace" : "Unknown");

describe("presentAuthor", () => {
  it("names a person through the roster, with no badge", () => {
    expect(presentAuthor({ author_id: "u_ada" }, person)).toEqual({
      name: "Ada Lovelace",
      via: null,
      title: null,
      badge: false,
    });
    // A row from before integrations has no kind at all — still a person.
    expect(isWebhookMessage({})).toBe(false);
  });

  it("badges an integration and never looks its id up as a member", () => {
    const p = presentAuthor(
      { author_id: "whk_1", author_kind: "webhook", author_name: "CI", author_via: "CI" },
      () => {
        throw new Error("a webhook id is not a member id");
      },
    );
    expect(p).toEqual({
      name: "CI",
      via: null,
      title: "Posted by the “CI” webhook",
      badge: true,
    });
  });

  it("keeps the webhook's real name beside a username override", () => {
    const p = presentAuthor(
      { author_id: "whk_1", author_kind: "webhook", author_name: "Ada", author_via: "Deploy bot" },
      person,
    );
    // The impersonation guarantee: "Ada" alone could pass for a member.
    expect(p.name).toBe("Ada");
    expect(p.via).toBe("Deploy bot");
    expect(p.badge).toBe(true);
  });

  it("falls back to a generic name when the webhook sent none", () => {
    expect(presentAuthor({ author_id: "whk_1", author_kind: "webhook" }, person).name).toBe(
      "Integration",
    );
  });

  it("treats a blank name as no name at all", () => {
    const p = presentAuthor(
      { author_id: "whk_1", author_kind: "webhook", author_name: "  ", author_via: "Deploy bot" },
      person,
    );
    expect(p).toMatchObject({ name: "Deploy bot", via: null });
  });

  it("treats a kind this build does not know as a person lookup", () => {
    expect(presentAuthor({ author_id: "u_ada", author_kind: "other" }, person).badge).toBe(false);
  });
});

describe("authorLabel", () => {
  it("is the plain name for a person and says (app) for an integration", () => {
    expect(authorLabel({ author_id: "u_ada" }, person)).toBe("Ada Lovelace");
    expect(
      authorLabel({ author_id: "whk_1", author_kind: "webhook", author_name: "CI" }, person),
    ).toBe("CI (app)");
    expect(
      authorLabel(
        { author_id: "whk_1", author_kind: "webhook", author_name: "CI", author_via: "Deploy bot" },
        person,
      ),
    ).toBe("CI · via Deploy bot (app)");
  });
});
