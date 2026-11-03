/*
# Lock page link after creation

Plain-English summary:
Owners can still choose their link when they create a page, but can no longer change it afterwards. This keeps ads and printed links from breaking.

1. Modified Privileges
- The `pages` table update permission no longer includes the link (slug) column. All other content columns remain editable.

2. Security
- Only the grant changes. Row rules are unchanged.
*/

REVOKE UPDATE ON pages FROM authenticated;
GRANT UPDATE (title, description, phone, icon, hours_mode, hours_from, hours_to, whatsapp, instagram, snapchat, tiktok, conversion_label) ON pages TO authenticated;
