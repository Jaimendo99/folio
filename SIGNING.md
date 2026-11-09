# Code signing

Signing is optional. Without these secrets (the current state of this fork) the release still builds: Windows
installers are unsigned, and the Mac app is ad-hoc signed and tells users about new versions instead of installing
them itself.

The release workflow uses two GitHub environments in **Jaimendo99/folio**. Keep Apple credentials in
`release-macos` and Azure credentials in `release-windows`.
Configure each environment to accept only release tags matching `v*` and require an independent release reviewer.
Protect the creation, update and deletion of those tags with a repository ruleset. These controls are configured
in GitHub. A workflow file in a tag cannot enforce restrictions on someone who can change that file.

For an existing deployment, provision the environment secrets from your signing credential store, verify the
expected credential names in each environment, then remove the repository-level copies. Rotate credentials that
may have been exposed previously. Windows builds can run unsigned
and macOS builds use an ad-hoc signature until those platform credentials are configured.

## macOS: Apple Developer ID (signing + notarization)

What it fixes: no "can't verify the developer" block on first launch, and **Macs install updates automatically** (the
build sets `folioMacSigned`, which turns on silent updates in `electron/main.cjs`).

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/) (US$99/year). An organization
   enrollment needs a D-U-N-S number and shows the company name; an individual enrollment shows your name.
2. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list), create a
   **Developer ID Application** certificate. On a Mac: Keychain Access → Certificate Assistant → Request a Certificate
   from a Certificate Authority, upload the request, download the certificate, and double-click it.
3. In Keychain Access, right-click the certificate → **Export** as `.p12` with a strong password.
4. Create an [app-specific password](https://account.apple.com) for your Apple ID (Sign-In and Security →
   App-Specific Passwords), and find your **Team ID** on the [membership page](https://developer.apple.com/account).
5. Add the secrets:

   ```sh
   base64 -i DeveloperID.p12 | gh secret set MAC_CERTIFICATE_P12_BASE64 --env release-macos --repo Jaimendo99/folio
   gh secret set MAC_CERTIFICATE_PASSWORD --env release-macos --repo Jaimendo99/folio      # the .p12 password
   gh secret set APPLE_ID --env release-macos --repo Jaimendo99/folio                      # your Apple ID email
   gh secret set APPLE_APP_SPECIFIC_PASSWORD --env release-macos --repo Jaimendo99/folio
   gh secret set APPLE_TEAM_ID --env release-macos --repo Jaimendo99/folio
   ```

The next `npm run release` produces a signed, notarized Mac app. Macs running an earlier, unsigned Folio still see the
"download" prompt once; after installing the signed version, updates are automatic.

## Windows: Azure Trusted Signing

What it fixes: no SmartScreen "Windows protected your PC" warning (reputation builds quickly for Trusted Signing
certificates), and Windows checks the publisher on every update.

1. In the [Azure portal](https://portal.azure.com), create a **Trusted Signing account** (Basic tier, about US$10/month)
   in a supported region, and note its **endpoint** (for example `https://eus.codesigning.azure.net`).
2. Complete **identity validation** (organization or individual). The validated name is the publisher Windows shows.
3. Create a **certificate profile** of type *Public Trust*.
4. Create an app registration (Microsoft Entra ID → App registrations), add a client secret, and give it the
   **Trusted Signing Certificate Profile Signer** role on the Trusted Signing account.
5. Add the secrets:

   ```sh
   gh secret set AZURE_TENANT_ID --env release-windows --repo Jaimendo99/folio
   gh secret set AZURE_CLIENT_ID --env release-windows --repo Jaimendo99/folio
   gh secret set AZURE_CLIENT_SECRET --env release-windows --repo Jaimendo99/folio
   gh secret set AZURE_SIGNING_ENDPOINT --env release-windows --repo Jaimendo99/folio     # e.g. https://eus.codesigning.azure.net
   gh secret set AZURE_SIGNING_ACCOUNT --env release-windows --repo Jaimendo99/folio      # Trusted Signing account name
   gh secret set AZURE_SIGNING_PROFILE --env release-windows --repo Jaimendo99/folio      # certificate profile name
   gh secret set AZURE_SIGNING_PUBLISHER --env release-windows --repo Jaimendo99/folio    # exactly the validated publisher name
   ```
