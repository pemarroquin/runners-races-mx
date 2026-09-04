// Settings › Your account — the email OTP link / sign-in flow.
//
// Nothing here but a home for AccountLink, which is self-contained: it
// fetches its own status, owns the email -> code state machine, and hides
// itself entirely on a build with no server configured (see its header, and
// src/lib/account.ts for what LINK vs SIGN IN mean). Giving it a page of its
// own is the whole change — no logic moved.
import { AccountLink } from '@/components/account-link';
import { SettingsPage, useSettingsColors } from '@/components/settings-ui';

export default function AccountSettingsScreen() {
  const { c } = useSettingsColors();
  return (
    <SettingsPage>
      <AccountLink c={c} />
    </SettingsPage>
  );
}
