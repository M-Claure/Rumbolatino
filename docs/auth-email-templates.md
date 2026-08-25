# Supabase authentication email templates

These live in the **Supabase dashboard**, not in this repository — Supabase
composes and sends every authentication email, and delivers it through Resend as
Custom SMTP. Nothing in `app/` or `lib/` can change them. This file is the
recommended content to paste in, and the reasoning for the shape.

**Where:** Supabase dashboard → **Authentication → Emails → Templates**.

Related: [`AUTH_PRODUCTION_SETUP.md`](../AUTH_PRODUCTION_SETUP.md) for everything
around them; `app/auth/confirm/route.ts` for the route they point at.

---

## The one thing that matters: `token_hash`, not `ConfirmationURL`

Supabase's stock templates send `{{ .ConfirmationURL }}`. That link routes
through the project's auth endpoint and comes back to the app as a **PKCE code**,
which can only be redeemed by **the browser that started the flow** — the
verifier is a cookie set on that browser at sign-up.

For this product that is the wrong browser most of the time. The employers this
directory exists for register on a shop computer, a laptop at the counter, or a
till-side tablet, and read their mail on a phone. A confirmation link that only
works where it was requested fails for them with no message that can help, and
this exact failure is why an earlier version of this codebase abandoned Supabase
verification entirely and issued its own tokens.

`{{ .TokenHash }}` fixes it. It is verified server-side with `verifyOtp`, carries
no PKCE verifier, and therefore **works in any browser on any device**. Every
template below uses it.

`/auth/callback` still exists and still handles the code flow, so a project whose
templates have not been replaced yet is not broken — just limited to same-browser
links. Replacing the templates is what removes that limitation.

---

## Conventions used below

- `{{ .SiteURL }}` is the **Site URL** configured under Authentication → URL
  Configuration. It must be the origin of the environment sending the mail.
- `&` is written raw, not as `&amp;`, matching Supabase's own documentation.
- `next=` is validated server-side against an allow-list
  (`lib/auth-redirect.ts`). A value outside it is replaced with `/empleadores`
  rather than followed, so a mistake here degrades to the directory instead of
  becoming an open redirect.
- `type=` must match the template. `verifyOtp` uses it to decide what it is
  verifying, and a mismatch fails the link.
- Colours are Rumbo Latino's `accentDark` (`#3B2E58`, plum), **not** `accent`
  (`#FF6F5E`, coral). An email has no stylesheet and no theme, so the colour has
  to be right when it is sent — and the coral/white pair is one of the documented
  below-AA combinations in `docs/branding.md`. Plum clears 4.5:1 against white.
  For an Aprende-branded project use `#030A64` (navy).
- No images, no tracking pixels, no external assets. A remote image is a read
  receipt on someone's mailbox and one more reason to be filtered.
- Every template is Spanish. So is every user-facing string in this product.

---

## 1. Confirm signup

**Subject:** `Confirma tu correo para entrar al directorio`

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:32rem;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">
  <p style="font-size:14px;font-weight:700;margin:0 0 24px;color:#3B2E58">Rumbo Latino</p>

  <h1 style="font-size:20px;margin:0 0 16px">Confirma tu correo</h1>

  <p style="margin:0 0 16px">
    Creaste una cuenta de empresa para buscar personas capacitadas y listas para trabajar.
    Confirma esta dirección para entrar al directorio.
  </p>

  <p style="margin:0 0 24px">
    <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/empleadores"
       style="display:inline-block;background:#3B2E58;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">
      Confirmar mi correo
    </a>
  </p>

  <p style="margin:0 0 8px;font-size:14px;color:#555">
    Si el botón no funciona, copia y pega esta dirección en tu navegador:
  </p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#555">
    {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/empleadores
  </p>

  <p style="margin:0 0 16px;font-size:14px;color:#555">
    Puedes abrir este enlace desde cualquier dispositivo, incluido tu teléfono.
  </p>

  <p style="font-size:12px;color:#666;margin-top:32px;border-top:1px solid #e5e5e5;padding-top:16px">
    Si no creaste esta cuenta, puedes ignorar este mensaje. Nadie podrá usarla sin confirmar
    este correo.
  </p>
</div>
```

The link is repeated as copyable text on purpose. Mail clients rewrite and
sometimes break anchors, and this link is the only way forward — a recipient with
a dead button and no visible URL cannot complete a sign-up at all.

---

## 2. Reset password

**Subject:** `Cambia tu contraseña`

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:32rem;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">
  <p style="font-size:14px;font-weight:700;margin:0 0 24px;color:#3B2E58">Rumbo Latino</p>

  <h1 style="font-size:20px;margin:0 0 16px">Cambia tu contraseña</h1>

  <p style="margin:0 0 16px">
    Pediste cambiar la contraseña de tu cuenta de empresa. Abre este enlace para elegir
    una nueva.
  </p>

  <p style="margin:0 0 24px">
    <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/empleadores/nueva-contrasena"
       style="display:inline-block;background:#3B2E58;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">
      Elegir una contraseña nueva
    </a>
  </p>

  <p style="margin:0 0 8px;font-size:14px;color:#555">
    Si el botón no funciona, copia y pega esta dirección en tu navegador:
  </p>
  <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#555">
    {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/empleadores/nueva-contrasena
  </p>

  <p style="margin:0 0 16px;font-size:14px;color:#555">
    Este enlace caduca pronto y solo se puede usar una vez.
  </p>

  <p style="font-size:12px;color:#666;margin-top:32px;border-top:1px solid #e5e5e5;padding-top:16px">
    Si no pediste este cambio, ignora este mensaje: tu contraseña sigue igual y nadie puede
    cambiarla sin abrir este enlace.
  </p>
</div>
```

The copy says "caduca pronto" rather than naming a number of minutes. The
lifetime is a project setting (Authentication → Sessions → Email OTP Expiration),
so a hardcoded "1 hora" here becomes a lie the moment someone changes it — and
copy that contradicts the real expiry turns a working system into a support
ticket. Name a duration only if you also commit to updating this when the setting
moves.

---

## 3. Change email address

**Not implemented in the UI.** Nothing in this app calls `updateUser({ email })`,
so this template is never triggered today. It is documented because Supabase
sends it if anyone changes an address from the dashboard or through the API, and
an unstyled English default would then reach a customer.

**Subject:** `Confirma tu nuevo correo`

```html
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:32rem;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">
  <p style="font-size:14px;font-weight:700;margin:0 0 24px;color:#3B2E58">Rumbo Latino</p>

  <h1 style="font-size:20px;margin:0 0 16px">Confirma tu nuevo correo</h1>

  <p style="margin:0 0 16px">
    Pediste cambiar el correo de tu cuenta de empresa de {{ .Email }} a {{ .NewEmail }}.
    Abre este enlace para confirmarlo.
  </p>

  <p style="margin:0 0 24px">
    <a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change&next=/empleadores"
       style="display:inline-block;background:#3B2E58;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">
      Confirmar el cambio
    </a>
  </p>

  <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#555">
    {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change&next=/empleadores
  </p>

  <p style="font-size:12px;color:#666;margin-top:32px;border-top:1px solid #e5e5e5;padding-top:16px">
    Si no pediste este cambio, ignora este mensaje y avísanos.
  </p>
</div>
```

**Before enabling an email-change flow in the UI, note the loose end:**
`employers.email` would keep the OLD address, because nothing mirrors the change
onto that row. The directory gate reads the session, so access would keep
working, but the reveal audit and every operator query would name an address the
person no longer uses. Wire the mirror before shipping the feature.

**Keep "Secure email change" ON** (Authentication → Providers → Email). It
requires confirmation from *both* addresses, so a stolen session cannot silently
move an account to an attacker's mailbox.

---

## 4. Magic Link and Invite

Neither is used. This app signs employers in with a password only, and sends no
invitations.

Leave them at their defaults, or paste the "Confirm signup" body with
`type=magiclink` / `type=invite` so that an accidental trigger — someone using
"Send magic link" from the dashboard's user list — does not produce an unbranded
English email. There is no security consequence either way: `/auth/confirm`
accepts both types and the resulting session still faces the same gate.

---

## After changing a template

1. Save it in the dashboard. There is no deploy — it takes effect immediately.
2. Register a test account and read the mail in a **different browser** than the
   one you registered in. That is the check that distinguishes a working
   `token_hash` template from a stock `ConfirmationURL` one; both look identical
   in the same browser.
3. Confirm the link lands on `/empleadores` **signed in**, not on
   `/empleadores/acceso`.

A link that bounces to `/empleadores/acceso?estado=…` names its own reason in the
notice — start there before reading logs.
