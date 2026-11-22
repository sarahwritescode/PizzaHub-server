# Vendor image upload (Task 05, ImgBB)

`POST /api/vendor/upload-image` takes 1 to 5 images from a signed-in **vendor**, sends them to
[ImgBB](https://api.imgbb.com/) and returns their URLs. The vendor then sends those URLs in the `images` array of
`POST /api/vendor/menu-items`. The menu API never sees the ImgBB key.

## Get an ImgBB API key (once)

1. Create a free account at <https://imgbb.com> and log in.
2. Open <https://api.imgbb.com/> and click **Get API key**. Copy the key.
3. Put it in `.env` (never commit `.env`; `.env.example` only has an empty placeholder):
   ```
   IMGBB_API_KEY=paste_your_key_here
   ```
4. Restart the server. On Vercel add `IMGBB_API_KEY` under Project Settings, Environment Variables, then redeploy.

The key is optional for the server to start. Without it everything else works and uploads answer
`503 UPLOAD_NOT_CONFIGURED` (after the files were validated).

## Request

`multipart/form-data`, field name **`images`** (repeat it for several files), `Authorization: Bearer <vendor JWT>`.

```
curl -X POST http://localhost:5000/api/vendor/upload-image \
  -H "Authorization: Bearer <JWT>" \
  -F "images=@pizza.jpg" -F "images=@pizza2.png"
```

## Responses

```json
// 201
{ "success": true, "message": "Images uploaded successfully",
  "data": { "images": [
    { "url": "https://i.ibb.co/xxxx/pizza.jpg", "display_url": "https://i.ibb.co/yyyy/pizza.jpg" } ] } }
```

- `url` is the full-size image: **store this one** in a menu item's `images`. `display_url` is ImgBB's resized
  version (only present when ImgBB returns it). Order is the same as the files in the request.
- ImgBB's `delete_url` is **not** returned (anyone holding it can delete the picture; nothing here uses it).
- Errors use the usual `{ success: false, message, code, errors? }`:

| Status | `code` | When |
|---|---|---|
| 401 / 403 | `NO_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `ACCOUNT_BLOCKED`, `FORBIDDEN` | not a signed-in, non-blocked vendor |
| 400 | `NO_FILES` | no file, or not multipart |
| 400 | `UNEXPECTED_FIELD` | file sent in a field other than `images` |
| 400 | `TOO_MANY_FILES` | more than 5 files |
| 400 | `EMPTY_FILE` | a 0-byte file |
| 400 | `INVALID_UPLOAD` | broken multipart body |
| 413 | `FILE_TOO_LARGE` | a file over 5 MB |
| 415 | `UNSUPPORTED_FILE_TYPE` | not JPEG / PNG / WEBP (by declared type **and** by content), or content does not match the declared type |
| 503 | `UPLOAD_NOT_CONFIGURED` | no `IMGBB_API_KEY` on the server |
| 502 | `UPLOAD_SERVICE_CONFIG_ERROR` | ImgBB rejected the key (server misconfiguration) |
| 503 | `UPLOAD_SERVICE_BUSY` | ImgBB rate limit |
| 504 | `UPLOAD_TIMEOUT` | ImgBB did not answer within 20 s |
| 502 | `UPLOAD_SERVICE_UNAVAILABLE` | network error reaching ImgBB |
| 502 | `UPLOAD_SERVICE_ERROR` | any other ImgBB failure |

## Validation (all of it happens before anything is sent to ImgBB)

- Order: login and vendor role are checked **before** the body is read, so nobody else can stream a file in.
- Max **5 files**, max **5 MB each** (enforced while reading, so a giant upload is cut off).
- Each file must be non-empty, declared as `image/jpeg`, `image/jpg`, `image/png` or `image/webp`, **and** its first
  bytes (magic numbers) must really be JPEG, PNG or WEBP **and** agree with the declared type. The file name/extension
  is never trusted (a renamed `.txt` or an `.exe` named `.jpg` is rejected; a real JPEG named `notes.txt` is accepted).
- If any file is invalid the whole request is rejected and **nothing** is uploaded; `errors` names the bad files
  (`images[1]`, ...).
- The client's file name is never forwarded to ImgBB (a generated name is used) and never used as a path. Files are
  kept in memory only: no temporary files exist, so there is nothing to clean up.

## ImgBB failures and partial results

Images are uploaded in parallel. If ImgBB fails for **some** of them the request counts as failed: status and `code`
of the first failure, `errors` per file (`images[1]`), and `data.images` holds the ones that **did** upload, each with
its `index`, so the client can keep those and retry only the rest. Pictures already on ImgBB stay there (harmless).
Provider messages, the API key and stack traces are never returned; the details are logged on the server without the
key.

```json
// 1 of 3 failed
{ "success": false, "message": "1 of 3 images could not be uploaded. The image service could not process this upload.",
  "code": "UPLOAD_SERVICE_ERROR",
  "errors": [ { "field": "images[1]", "code": "UPLOAD_SERVICE_ERROR", "message": "The image service could not process this upload." } ],
  "data": { "images": [ { "index": 0, "url": "https://i.ibb.co/..." }, { "index": 2, "url": "https://i.ibb.co/..." } ] } }
```

## Vercel limit (important)

Vercel serverless functions reject request bodies larger than **about 4.5 MB** (HTTP 413, before the request reaches
Express). So on Vercel a single 5 MB image, or several images in one request, can fail even though this API allows
them. Keep uploads small (compress in the browser, or upload one image per request), or host the API where the limit
is higher. Locally the full 5 x 5 MB limit applies.

## Automated check

```bash
npm run verify:upload
```

Real sign-up, real Better Auth JWTs, real multipart uploads through the real app, in a throwaway database (dropped at
the end). **ImgBB itself is replaced by a stand-in** for the success cases (no real key is available to the script), so
those prove this server's behaviour, not that ImgBB accepts your key. The invalid-key case calls the **real** ImgBB with
a junk key and checks its real `400 / code 100 / "Invalid API v1 key."` answer (needs internet; skipped if offline).

## Postman

Import [postman/PizzaHub-ImageUpload.postman_collection.json](postman/PizzaHub-ImageUpload.postman_collection.json).
Use a demo database like in [VENDOR_MENU_TESTING.md](VENDOR_MENU_TESTING.md) (`$env:DB_NAME = "pizzahub_vendor_demo"; npm run dev`).

### How to send a file (Body, form-data)

1. Method **POST**, URL `{{baseUrl}}/api/vendor/upload-image`.
2. **Authorization** tab: type *Bearer Token*, value `{{vendorToken}}` (the collection's setup folder fills it).
3. **Body** tab, select **form-data** (not raw, not x-www-form-urlencoded).
4. In the first row type the **Key** `images`, then hover the key cell and change the dropdown on the right from *Text*
   to **File**.
5. In the **Value** cell click **Select Files** and choose the image.
6. For several images add more rows, each with key `images` and type *File* (or select several files in one row).
7. **Do not** set a `Content-Type` header yourself: Postman adds `multipart/form-data; boundary=...` automatically.
8. Click **Send**.

In the collection every upload request already has its file rows; you only click *Select Files* in each.

### Test cases

Run folder 1 **first** with an empty cookie jar (otherwise the session cookie from a previous login authenticates
the "no login" request), then folders 2 to 7 in order.

| # | Case | Folder / request | Expected |
|---|---|---|---|
| 1 | Valid JPEG | 4, T1/T11 | 201, `data.images[0].url` is an `https://i.ibb.co/...` URL (**needs a real key**) |
| 2 | Valid PNG | 4, T2 | 201 (real key) |
| 3 | Valid WEBP | 4, T3 | 201 (real key) |
| 4 | Several images | 4, T4 (3 files) | 201, 3 urls in the same order (real key) |
| 5 | More than 5 images | 5, T5 (6 files) | 400 `TOO_MANY_FILES` |
| 6 | Image over 5 MB | 5, T6 | 413 `FILE_TOO_LARGE` |
| 7 | Unsupported file | 5, T7 (.gif/.pdf/.txt) and T7b (renamed .txt) | 415 `UNSUPPORTED_FILE_TYPE` |
| 8 | Empty file | 5, T8 (`New-Item empty.jpg` in PowerShell) | 400 `EMPTY_FILE` |
| 9 | No login | 1, T9 | 401 `NO_CREDENTIALS` |
| 10 | Customer | 3, T10 | 403 `FORBIDDEN` |
| 11 | Vendor | 4, T1 | 201 (real key) |
| 12 | Invalid ImgBB key | 6, T12 | 502 `UPLOAD_SERVICE_CONFIG_ERROR`: put `IMGBB_API_KEY=invalid` in `.env`, restart, run, then **restore your real key** |
| 13 | Network error | 6, T13 | 502 `UPLOAD_SERVICE_UNAVAILABLE`: add `127.0.0.1 api.imgbb.com` to `C:\Windows\System32\drivers\etc\hosts` (as administrator), run `ipconfig /flushdns`, run the request, then **remove the line** and flush again. (Do not switch the whole network off: the server needs MongoDB to check your login.) |
| 14 | Use the URL in a menu item | 7, T14 | 201, `status: pending`, `images[0]` equals the uploaded URL |

Cases 5 to 10 work **without** an ImgBB key. Cases 1 to 4, 11 and 14 need a **real** key. Case 12 needs a wrong key
set (it contacts the real ImgBB, so internet is needed), case 13 needs any key set (without one you get
`503 UPLOAD_NOT_CONFIGURED` before the network is touched). Extra requests: no file (`NO_FILES`) and a wrong field name (`UNEXPECTED_FIELD`).

The collection's scripts were only checked for syntax, not run in Postman (file rows have to be picked by hand).
