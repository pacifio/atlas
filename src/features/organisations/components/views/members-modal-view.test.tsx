// @vitest-environment happy-dom
//
// The members manager's view: search, the admin-only controls, each row's
// menu, and the invite band's address parsing.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@tryatlas/design";

import { dedupe, isEmail, splitEmails } from "./email-chips-input";
import { MembersModalView, type InviteBand, type MemberRowData } from "./members-modal-view";

afterEach(cleanup);

const open = { menu: true, roles: true, actionAllowed: true, blockedReason: null };
const MEMBERS: MemberRowData[] = [
  {
    id: "m1",
    name: "Dev Halvorsen",
    email: "dev@acme.dev",
    role: "admin",
    isOwner: false,
    createdAt: null,
    avatarSrc: null,
    self: true,
    access: {
      menu: true,
      roles: true,
      actionAllowed: false,
      blockedReason: "You're the only admin — give someone else the Admin role first.",
    },
  },
  {
    id: "m2",
    name: "Priya Raghunathan",
    email: "priya@acme.dev",
    role: "product_owner",
    isOwner: false,
    createdAt: null,
    avatarSrc: null,
    self: false,
    access: open,
  },
  {
    id: "m3",
    name: "",
    email: "sam@acme.dev",
    role: null,
    isOwner: false,
    createdAt: null,
    avatarSrc: null,
    self: false,
    access: { menu: false, roles: false, actionAllowed: false, blockedReason: null },
  },
];

const invite = (over: Partial<InviteBand> = {}): InviteBand => ({
  emails: [],
  draft: "",
  role: "developer",
  sending: false,
  onEmailsChange: () => {},
  onDraftChange: () => {},
  onRoleChange: () => {},
  onSubmit: () => {},
  ...over,
});

function mount(props: Partial<Parameters<typeof MembersModalView>[0]> = {}) {
  const handlers = { onRoleChange: vi.fn(), onRemove: vi.fn(), onLeave: vi.fn() };
  render(
    <TooltipProvider>
      <MembersModalView
        open
        onOpenChange={() => {}}
        orgName="Acme"
        body="ready"
        error={null}
        refreshing={false}
        canRefresh
        onRefresh={() => {}}
        isAdmin
        tab="members"
        onTabChange={() => {}}
        members={MEMBERS}
        invitations={[]}
        onCancelInvite={() => {}}
        onCopyInviteLink={() => {}}
        invite={invite()}
        leave={{ open: false, leaving: false, onlyOrg: false, onConfirm() {}, onCancel() {} }}
        {...handlers}
        {...props}
      />
    </TooltipProvider>,
  );
  return handlers;
}

describe("MembersModalView", () => {
  it("search narrows the rows", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
      target: { value: "priya" },
    });
    expect(screen.getByText("Priya Raghunathan")).toBeTruthy();
    expect(screen.queryByText("Dev Halvorsen")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No people match.")).toBeTruthy();
  });

  it("a row menu changes the role once", async () => {
    const { onRoleChange } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Manage Priya Raghunathan" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Developer" }));
    expect(onRoleChange).toHaveBeenCalledExactlyOnceWith("m2", "developer");
  });

  it("the sole admin's own Leave is disabled", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Manage Dev Halvorsen" }));
    const leave = await screen.findByRole("menuitem", { name: /Leave organization/ });
    expect(leave.getAttribute("aria-disabled")).toBe("true");
  });

  it("a row without access has no menu, and a blank name shows the email once", () => {
    mount();
    expect(screen.queryByRole("button", { name: /sam@acme.dev/ })).toBeNull();
    expect(screen.getAllByText("sam@acme.dev")).toHaveLength(1);
  });

  it("Invite is disabled with an invalid chip, and absent without the band", () => {
    mount({ invite: invite({ emails: ["a@b.co", "not-an-email"] }) });
    const button = screen.getByRole("button", { name: /Invite/ });
    expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    cleanup();
    mount({ invite: null, isAdmin: false });
    expect(screen.queryByRole("button", { name: /^Invite/ })).toBeNull();
  });

  it("renders the load error", () => {
    mount({ body: "error", error: "Couldn't load members." });
    expect(within(document.body).getByText("Couldn't load members.")).toBeTruthy();
  });
});

describe("invite address parsing", () => {
  it("splits on commas, semicolons and whitespace", () => {
    expect(splitEmails("a@b.co, c@d.co;e@f.co\n")).toEqual(["a@b.co", "c@d.co", "e@f.co"]);
  });
  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(dedupe(["A@b.co", "a@B.co", "c@d.co"])).toEqual(["A@b.co", "c@d.co"]);
  });
  it("rejects an address with no dot in the domain", () => {
    expect(isEmail("x@y")).toBe(false);
    expect(isEmail("x@y.co")).toBe(true);
  });
});
