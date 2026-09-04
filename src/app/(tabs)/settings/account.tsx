// Settings › Your account — the email OTP link / sign-in flow.
//
// Nothing here but a home for AccountLink, which is self-contained: it
// fetches its own status, owns the email -> code state machine, and hides
// itself entirely on a build with no server configured (see its header, and
// src/lib/account.ts for what LINK vs SIGN IN mean). Giving it a page of its
// own is the whole change — no logic moved.
//
// IdentityDiagnostic sits under it for the same reason it sat under it in
// the old single-file screen: "which account am I, and what does the server
// actually have for it" is the question a runner reaches for only once the
// account copy above has failed to explain what they're seeing. See that
// component's header for why it's visible rather than hidden behind a
// gesture.
import { AccountLink } from '@/components/account-link';
import { IdentityDiagnostic } from '@/components/identity-diagnostic';
import { SettingsPage, useSettingsColors } from '@/components/settings-ui';

export default function AccountSettingsScreen() {
  const { c } = useSettingsColors();
  return (
    <SettingsPage>
      <AccountLink c={c} />
      <IdentityDiagnostic c={c} />
    </SettingsPage>
  );
}
