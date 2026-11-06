// @vitest-environment happy-dom
//
// The account avatar's fallback initial, and the account menu's signed-in /
// signed-out shapes.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@tryatlas/design";

import { AccountAvatarView, initialOf } from "./account-avatar-view";
import { AccountMenuView } from "./account-menu-view";

afterEach(cleanup);

describe("initialOf", () => {
  it.each([
    ["", "ålice@x.co", "Å"],
    ["ålice", "", "Å"],
    ["🦊 Fox", "", "🦊"],
    ["", "", "?"],
    ["  ", " bob@x.co ", "B"],
  ])("(%j, %j) → %s", (name, email, letter) => expect(initialOf(name, email)).toBe(letter));
});

describe("AccountAvatarView", () => {
  it("shows the initial when there is no photo", () => {
    render(<AccountAvatarView name="Priya" email="p@x.co" src={null} size={18} />);
    expect(screen.getByText("P")).toBeTruthy();
  });
});

function openMenu(props: Partial<Parameters<typeof AccountMenuView>[0]> = {}) {
  const handlers = { onSignIn: vi.fn(), onOpenSection: vi.fn(), onSignOut: vi.fn() };
  render(
    <TooltipProvider>
      <AccountMenuView
        user={null}
        signedIn={false}
        themeMode="system"
        themeModes={[{ value: "system", label: "System" }]}
        onThemeModeChange={() => {}}
        scaleLabel="100%"
        interfaceSizePanel={null}
        {...handlers}
        {...props}
      >
        <button type="button">Account</button>
      </AccountMenuView>
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Account" }));
  return handlers;
}

describe("AccountMenuView", () => {
  it("signed out offers Sign in and no Log out", async () => {
    const { onSignIn } = openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sign in/ }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: /Log out/ })).toBeNull();
  });

  it("signed in without a profile has Log out and no header", async () => {
    openMenu({ signedIn: true, user: null });
    expect(await screen.findByRole("menuitem", { name: /Log out/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Sign in/ })).toBeNull();
    expect(screen.queryByRole("group", { name: /@/ })).toBeNull();
  });

  it("shows a blank-named user's email once", async () => {
    openMenu({ signedIn: true, user: { name: " ", email: "a@b.co", avatar: null } });
    expect(await screen.findAllByText("a@b.co")).toHaveLength(1);
  });

  it("Settings opens the general section", async () => {
    const { onOpenSection } = openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Settings/ }));
    expect(onOpenSection).toHaveBeenCalledWith("general");
  });
});
