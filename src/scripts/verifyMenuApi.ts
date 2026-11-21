/**
 * Checks the public menu API end to end over real HTTP: `npm run verify:menu`.
 *
 * It never touches your real data. DB_NAME is switched to a throwaway database
 * (pizzahub_menu_verify_<timestamp>) BEFORE the app is loaded, test items are
 * created there, and the database is dropped at the end.
 */
process.env.DB_NAME = `pizzahub_menu_verify_${Date.now()}`;

const { ObjectId } = await import("mongodb");
const { default: app } = await import("../app.js");
const { client, connectDB, getDB } = await import("../config/db.js");
const { initializeDatabase } = await import("../config/initDatabase.js");
const { menuItemsCollection } = await import("../models/index.js");

let passed = 0;
const failures: string[] = [];

const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : `\n       got: ${JSON.stringify(detail)}`}`);
  }
};

// biome-ignore lint: test helper, responses are checked field by field below
type Json = any;

let baseUrl = "";

const get = async (path: string): Promise<{ status: number; body: Json }> => {
  const response = await fetch(baseUrl + path);
  return { status: response.status, body: await response.json() };
};

const names = (res: { body: Json }): string[] => res.body.data.map((item: Json) => item.itemName);

const isSorted = (values: number[], direction: "asc" | "desc") =>
  values.every((value, i) => i === 0 || (direction === "asc" ? values[i - 1] <= value : values[i - 1] >= value));

const section = (title: string) => console.log(`\n${title}`);

const vendorId = new ObjectId();
const day = (n: number) => new Date(Date.UTC(2026, 0, n));

type Seed = {
  itemName: string;
  category: string;
  description: string;
  price: number;
  location: string;
  status: "pending" | "approved" | "rejected" | "inactive";
  createdAt: Date;
};

const item = (seed: Partial<Seed> & Pick<Seed, "itemName" | "createdAt">): Seed => ({
  category: "Misc",
  description: "Tasty food",
  price: 100,
  location: "Sylhet",
  status: "approved",
  ...seed,
});

const server = app.listen(0);

try {
  await connectDB();
  await initializeDatabase();

  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;

  // ---------------------------------------------------------------- empty DB
  section("Empty database");
  {
    const list = await get("/api/menu-items");
    check("list -> 200 with empty data", list.status === 200 && Array.isArray(list.body.data) && list.body.data.length === 0, list);
    check(
      "list -> pagination is all zeros",
      list.body.pagination?.totalItems === 0 &&
        list.body.pagination?.totalPages === 0 &&
        list.body.pagination?.hasNextPage === false &&
        list.body.pagination?.hasPreviousPage === false,
      list.body.pagination
    );
    const categories = await get("/api/categories");
    check("categories -> 200 with []", categories.status === 200 && categories.body.data.length === 0, categories);
    const featured = await get("/api/menu-items/featured");
    check("featured -> 200 with []", featured.status === 200 && featured.body.data.length === 0, featured);
  }

  // --------------------------------------------------------------- test data
  const approved: Seed[] = [
    item({ itemName: "Margherita Pizza", category: "Pizza", description: "Classic tomato and cheese", price: 400, location: "Dhaka", createdAt: day(20) }),
    item({ itemName: "Chicken Supreme Pizza", category: "Chicken", description: "Loaded with chicken", price: 650, location: "Dhaka", createdAt: day(19) }),
    item({ itemName: "Chicken Tikka Pizza", category: "Chicken", description: "Spicy tikka", price: 500, location: "Chittagong", createdAt: day(18) }),
    item({ itemName: "BBQ Chicken Wings", category: "Chicken", description: "Smoky wings", price: 300, location: "Chittagong", createdAt: day(17) }),
    item({ itemName: "Beef Burger", category: "Burger", description: "Not a pizza, a burger", price: 250, location: "Dhaka, Bangladesh", createdAt: day(16) }),
    item({ itemName: "Spicy (Hot) [XL] .* Special", category: "Special", description: "Regex characters in the name", price: 700, location: "Rajshahi", createdAt: day(15) }),
    item({ itemName: "Lowercase Chicken Roll", category: "chicken", description: "Wrapped chicken", price: 200, location: "Khulna", createdAt: day(14) }),
  ];

  // Same price AND older than everything above: used to test stable pagination.
  const fillers: Seed[] = Array.from({ length: 15 }, (_, i) =>
    item({ itemName: `Filler Item ${String(i + 1).padStart(2, "0")}`, category: "Filler", price: 150, createdAt: day(1) })
  );

  const hidden: Seed[] = [
    item({ itemName: "Pending Pizza", category: "PendingOnlyCategory", status: "pending", createdAt: day(25) }),
    item({ itemName: "Rejected Pizza", category: "RejectedOnlyCategory", status: "rejected", createdAt: day(24) }),
    item({ itemName: "Inactive Pizza", category: "InactiveOnlyCategory", status: "inactive", createdAt: day(23) }),
  ];

  const TOTAL_APPROVED = approved.length + fillers.length; // 22

  const insert = await menuItemsCollection().insertMany(
    [...approved, ...fillers, ...hidden].map((seed) => ({
      ...seed,
      vendorId,
      images: ["https://example.com/pizza.jpg"],
    }))
  );
  const idOf = (index: number) => insert.insertedIds[index]!;
  const hiddenId = (i: number) => idOf(approved.length + fillers.length + i);

  // ---------------------------------------------------------------- list
  section("GET /api/menu-items (visibility, fields, pagination)");
  {
    const res = await get("/api/menu-items");
    check("-> 200 and success=true", res.status === 200 && res.body.success === true, res.body.message);
    check("message is set", res.body.message === "Menu items fetched successfully");
    check("default page=1, limit=12", res.body.pagination.page === 1 && res.body.pagination.limit === 12, res.body.pagination);
    check(`totalItems=${TOTAL_APPROVED}, totalPages=2`, res.body.pagination.totalItems === TOTAL_APPROVED && res.body.pagination.totalPages === 2, res.body.pagination);
    check("hasNextPage=true, hasPreviousPage=false", res.body.pagination.hasNextPage === true && res.body.pagination.hasPreviousPage === false);
    check("12 items on page 1", res.body.data.length === 12);
    check("default order is newest first", isSorted(res.body.data.map((x: Json) => new Date(x.createdAt).getTime()), "desc"));

    const everything = await get("/api/menu-items?limit=50");
    const all = names(everything);
    check("pending/rejected/inactive items are never listed", !all.some((n) => /^(Pending|Rejected|Inactive) Pizza$/.test(n)), all);

    const first = res.body.data[0];
    check("item exposes only public fields", JSON.stringify(Object.keys(first).sort()) === JSON.stringify(["_id", "category", "createdAt", "description", "images", "itemName", "location", "price"]), Object.keys(first));
    check("vendorId and status are not exposed", !("vendorId" in first) && !("status" in first));

    const page2 = await get("/api/menu-items?page=2&limit=12");
    check("page=2&limit=12 -> 10 items, hasNext=false, hasPrev=true", page2.body.data.length === 10 && page2.body.pagination.hasNextPage === false && page2.body.pagination.hasPreviousPage === true, page2.body.pagination);

    const beyond = await get("/api/menu-items?page=99");
    check("page beyond the end -> 200 with empty data", beyond.status === 200 && beyond.body.data.length === 0 && beyond.body.pagination.totalItems === TOTAL_APPROVED);

    // Walk every page of price-sorted data (15 items share one price): no duplicates, none missing.
    const seen: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const res5 = await get(`/api/menu-items?sortBy=price&order=asc&limit=5&page=${page}`);
      seen.push(...res5.body.data.map((x: Json) => x._id));
    }
    check(`walking 5 pages of 5 returns all ${TOTAL_APPROVED} items exactly once`, seen.length === TOTAL_APPROVED && new Set(seen).size === TOTAL_APPROVED, { total: seen.length, unique: new Set(seen).size });
  }

  // ---------------------------------------------------------------- search
  section("Search (itemName, description, category, location; case-insensitive)");
  {
    const pizza = await get("/api/menu-items?search=pizza");
    const found = names(pizza).sort();
    check(
      "search=pizza matches name AND description",
      JSON.stringify(found) === JSON.stringify(["Beef Burger", "Chicken Supreme Pizza", "Chicken Tikka Pizza", "Margherita Pizza"]),
      found
    );
    check("search=pizza excludes hidden pizzas", !found.some((n) => /^(Pending|Rejected|Inactive) Pizza$/.test(n)));

    const upper = await get("/api/menu-items?search=PIZZA");
    check("search is case-insensitive (PIZZA)", upper.body.pagination.totalItems === pizza.body.pagination.totalItems);

    const byLocation = await get("/api/menu-items?search=rajshahi");
    check("search matches location", JSON.stringify(names(byLocation)) === JSON.stringify(["Spicy (Hot) [XL] .* Special"]), names(byLocation));

    const byCategory = await get("/api/menu-items?search=burger");
    check("search matches category/name", JSON.stringify(names(byCategory)) === JSON.stringify(["Beef Burger"]), names(byCategory));

    const none = await get("/api/menu-items?search=zzzznothing");
    check("no match -> 200, empty data, totalItems=0", none.status === 200 && none.body.data.length === 0 && none.body.pagination.totalItems === 0);

    const trimmed = await get("/api/menu-items?search=%20%20");
    check("blank search is ignored", trimmed.status === 200 && trimmed.body.pagination.totalItems === TOTAL_APPROVED);
  }

  // -------------------------------------------------- regex safety
  section("Regex special characters are treated as plain text");
  {
    const dotStar = await get(`/api/menu-items?search=${encodeURIComponent(".*")}`);
    check("search=.* matches only the literal '.*' (not everything)", dotStar.status === 200 && JSON.stringify(names(dotStar)) === JSON.stringify(["Spicy (Hot) [XL] .* Special"]), names(dotStar));

    for (const evil of ["(", "[", "\\", "(a+)+$", "^", "$ne", "{}"]) {
      const res = await get(`/api/menu-items?search=${encodeURIComponent(evil)}`);
      check(`search=${evil} does not crash (200)`, res.status === 200, res.body);
    }

    const parens = await get(`/api/menu-items?search=${encodeURIComponent("(Hot)")}`);
    check("search=(Hot) finds the item with literal parentheses", names(parens).length === 1);

    const operator = await get("/api/menu-items?search[$ne]=x");
    check("search[$ne]=x (operator injection) is not interpreted", operator.status === 200 && operator.body.pagination.totalItems === TOTAL_APPROVED, operator.body.pagination);
  }

  // ---------------------------------------------------------------- filters
  section("Category and location filters");
  {
    const chicken = await get("/api/menu-items?category=chicken");
    check("category=chicken -> 4 items (Chicken and chicken)", chicken.body.pagination.totalItems === 4, names(chicken));
    check("category filter is an exact match: category=chick -> 0", (await get("/api/menu-items?category=chick")).body.pagination.totalItems === 0);
    check("category=PendingOnlyCategory -> 0 (hidden items stay hidden)", (await get("/api/menu-items?category=PendingOnlyCategory")).body.pagination.totalItems === 0);

    const dhaka = await get("/api/menu-items?location=dhaka");
    check("location=dhaka -> Dhaka and 'Dhaka, Bangladesh'", JSON.stringify(names(dhaka).sort()) === JSON.stringify(["Beef Burger", "Chicken Supreme Pizza", "Margherita Pizza"]), names(dhaka));
    check("location=DHAKA is case-insensitive", (await get("/api/menu-items?location=DHAKA")).body.pagination.totalItems === 3);
    check("location=%2E* is literal (0 results)", (await get("/api/menu-items?location=.*")).body.pagination.totalItems === 0);
  }

  // ---------------------------------------------------------------- sorting
  section("Sorting");
  {
    const asc = await get("/api/menu-items?sortBy=price&order=asc&limit=50");
    const desc = await get("/api/menu-items?sortBy=price&order=desc&limit=50");
    const ascPrices = asc.body.data.map((x: Json) => x.price);
    const descPrices = desc.body.data.map((x: Json) => x.price);
    check("price asc: cheapest first (150..700)", isSorted(ascPrices, "asc") && ascPrices[0] === 150 && ascPrices.at(-1) === 700, ascPrices);
    check("price desc: dearest first (700..150)", isSorted(descPrices, "desc") && descPrices[0] === 700 && descPrices.at(-1) === 150, descPrices);

    const newest = await get("/api/menu-items?sortBy=createdAt&order=desc&limit=50");
    const oldest = await get("/api/menu-items?sortBy=createdAt&order=asc&limit=50");
    check("createdAt desc: newest first", newest.body.data[0].itemName === "Margherita Pizza" && isSorted(newest.body.data.map((x: Json) => +new Date(x.createdAt)), "desc"));
    check("createdAt asc: oldest first", oldest.body.data[0].itemName.startsWith("Filler Item") && isSorted(oldest.body.data.map((x: Json) => +new Date(x.createdAt)), "asc"));
  }

  // ---------------------------------------------------------------- combined
  section("Search + filter + sort + pagination together");
  {
    const res = await get("/api/menu-items?search=pizza&category=chicken&sortBy=price&order=asc&page=1&limit=12");
    check("-> Tikka (500) then Supreme (650)", res.status === 200 && JSON.stringify(names(res)) === JSON.stringify(["Chicken Tikka Pizza", "Chicken Supreme Pizza"]), names(res));
    check("totalItems reflects the filters (2), 1 page", res.body.pagination.totalItems === 2 && res.body.pagination.totalPages === 1, res.body.pagination);

    const paged = await get("/api/menu-items?category=chicken&sortBy=price&order=asc&page=2&limit=3");
    check("filter + limit=3&page=2 -> 1 item (the 4th), hasPrev=true, hasNext=false", paged.body.data.length === 1 && paged.body.data[0].price === 650 && paged.body.pagination.totalPages === 2 && paged.body.pagination.hasPreviousPage === true && paged.body.pagination.hasNextPage === false, paged.body);
  }

  // ---------------------------------------------------------------- validation
  section("Invalid query values -> 400 (nothing is guessed)");
  {
    const bad = [
      "page=0", "page=-1", "page=abc", "page=1.5", "page=", "page=100001",
      "limit=0", "limit=-5", "limit=51", "limit=abc", "limit=1e2",
      "sortBy=name", "sortBy=vendorId", "order=up", "order=ASC",
      "search=a&search=b", `search=${"x".repeat(101)}`,
      "category=a&category=b", "location=a&location=b",
    ];
    for (const query of bad) {
      const res = await get(`/api/menu-items?${query}`);
      const label = query.length > 40 ? `${query.slice(0, 40)}...` : query;
      check(`?${label} -> 400 with errors[]`, res.status === 400 && res.body.success === false && Array.isArray(res.body.errors) && res.body.errors.length > 0, res);
    }

    const sample = await get("/api/menu-items?page=0&limit=51");
    check("error body: success, message, code, errors[{field,message}]", sample.body.message === "Validation failed" && sample.body.code === "VALIDATION_ERROR" && sample.body.errors.map((e: Json) => e.field).sort().join() === "limit,page", sample.body);

    check("limit=50 is accepted", (await get("/api/menu-items?limit=50")).status === 200);
    check("limit=1&page=22 is accepted", (await get("/api/menu-items?limit=1&page=22")).body.data.length === 1);
  }

  // ---------------------------------------------------------------- single
  section("GET /api/menu-items/:id");
  {
    const ok = await get(`/api/menu-items/${idOf(0)}`);
    check("approved item -> 200", ok.status === 200 && ok.body.success === true && ok.body.data.itemName === "Margherita Pizza", ok.body);
    check("single response has no pagination", !("pagination" in ok.body));
    check("single response hides vendorId/status", !("vendorId" in ok.body.data) && !("status" in ok.body.data));

    const invalid = await get("/api/menu-items/INVALID_ID");
    check("INVALID_ID -> 400", invalid.status === 400 && invalid.body.success === false && invalid.body.errors?.[0]?.field === "id", invalid.body);
    check("12-char non-hex id -> 400", (await get("/api/menu-items/abcdefghijkl")).status === 400);

    const missing = await get(`/api/menu-items/${new ObjectId()}`);
    check("valid but unknown id -> 404", missing.status === 404 && missing.body.success === false && missing.body.code === "MENU_ITEM_NOT_FOUND", missing.body);

    for (const [i, label] of ["pending", "rejected", "inactive"].entries()) {
      const res = await get(`/api/menu-items/${hiddenId(i)}`);
      check(`${label} item -> 404 (same as missing, nothing leaked)`, res.status === 404 && res.body.message === missing.body.message, res.body);
    }
  }

  // ---------------------------------------------------------------- categories
  section("GET /api/categories");
  {
    const res = await get("/api/categories");
    const list: { name: string; count: number }[] = res.body.data;
    const lower = list.map((c) => c.name.toLowerCase());

    check("-> 200 and success=true", res.status === 200 && res.body.success === true && res.body.message === "Categories fetched successfully", res.body);
    check("each entry is { name, count }", list.every((c) => Object.keys(c).sort().join() === "count,name"), list[0]);
    check("no duplicates (Chicken + chicken merged)", new Set(lower).size === lower.length, lower);
    check("Chicken count = 4", list.find((c) => c.name.toLowerCase() === "chicken")?.count === 4, list);
    check("Filler count = 15", list.find((c) => c.name === "Filler")?.count === 15, list);
    check("counts add up to all approved items", list.reduce((sum, c) => sum + c.count, 0) === TOTAL_APPROVED);
    check("hidden-only categories are absent", !lower.some((name) => name.endsWith("onlycategory")), lower);
    check("no empty category", list.every((c) => c.name.trim() !== ""));
    check("sorted alphabetically", JSON.stringify(lower) === JSON.stringify([...lower].sort()), lower);
  }

  // ---------------------------------------------------------------- featured
  section("GET /api/menu-items/featured");
  {
    const res = await get("/api/menu-items/featured");
    check("-> 200 (not mistaken for an :id)", res.status === 200 && res.body.success === true, res.body);
    check("at most 6 items", res.body.data.length === 6, res.body.data.length);
    check("newest approved first", JSON.stringify(names(res)) === JSON.stringify(["Margherita Pizza", "Chicken Supreme Pizza", "Chicken Tikka Pizza", "BBQ Chicken Wings", "Beef Burger", "Spicy (Hot) [XL] .* Special"]), names(res));
    check("pending/rejected/inactive are excluded even though they are newer", !names(res).some((n) => /^(Pending|Rejected|Inactive) Pizza$/.test(n)));
    check("no pagination block", !("pagination" in res.body));
    check("only public fields", !("vendorId" in res.body.data[0]) && !("status" in res.body.data[0]));
  }

  // ---------------------------------------------------------------- unchanged things
  section("Existing behaviour is untouched");
  {
    check("/api/health -> 200", (await get("/api/health")).status === 200);
    const protectedRoute = await get("/api/test/protected");
    check("/api/test/protected without login -> 401", protectedRoute.status === 401 && protectedRoute.body.code === "NO_CREDENTIALS", protectedRoute.body);
    const unknown = await get("/api/nope");
    check("unknown route -> 404 JSON", unknown.status === 404 && unknown.body.success === false);
    const post = await fetch(`${baseUrl}/api/menu-items`, { method: "POST" });
    check("POST /api/menu-items is not available (404)", post.status === 404);
  }
} catch (error) {
  failures.push("script crashed");
  console.error("\nScript crashed:", error);
} finally {
  server.close();

  try {
    await getDB().dropDatabase();
  } catch (error) {
    console.error("Could not drop the throwaway database:", error);
  }

  await client.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed:\n - " + failures.join("\n - "));
  process.exit(1);
}
