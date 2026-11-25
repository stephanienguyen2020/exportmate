import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  arcPath,
  floodView,
  plural,
  productKey,
  productionView,
  routeStart,
  supplierKey,
  worst,
  type LonLat,
  type Tone,
} from "./model";
import type { MapSite, SatelliteObservation } from "../api";

const tone = fc.constantFrom<Tone>("red", "amber", "green");
const lonLat: fc.Arbitrary<LonLat> = fc.tuple(
  fc.double({ min: -180, max: 180, noNaN: true }),
  fc.double({ min: -85, max: 85, noNaN: true }),
);

describe("worst", () => {
  it("ranks red over amber over green, and is green for nothing", () => {
    expect(worst([])).toBe("green");
    expect(worst(["green", "amber"])).toBe("amber");
    expect(worst(["amber", "red", "green"])).toBe("red");
  });

  it("ignores order and combines across groups", () => {
    fc.assert(
      fc.property(fc.array(tone), fc.array(tone), (a, b) => {
        expect(worst([...a].reverse())).toBe(worst(a));
        expect(worst([...a, ...b])).toBe(worst([worst(a), worst(b)]));
        if (a.length) expect(a).toContain(worst(a));
      }),
    );
  });
});

describe("keys", () => {
  it("match the backend's supplier_name_key", () => {
    expect(supplierKey("  Saigon   Knit\tCo. ")).toBe("saigon knit co.");
  });

  it("are idempotent and ignore case and spacing", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(supplierKey(supplierKey(s))).toBe(supplierKey(s));
        expect(productKey(productKey(s))).toBe(productKey(s));
        expect(supplierKey(` ${s.toUpperCase()}  `)).toBe(supplierKey(s.toUpperCase()));
      }),
    );
  });
});

describe("plural", () => {
  it("adds an s except for one", () => {
    expect(plural(1, "order")).toBe("1 order");
    expect(plural(0, "order")).toBe("0 orders");
    expect(plural(3, "order")).toBe("3 orders");
  });
});

describe("productionView", () => {
  it("is null without places", () => expect(productionView([])).toBeNull());

  it("frames every place with room to spare, at least 4° across", () => {
    fc.assert(
      fc.property(fc.array(lonLat, { minLength: 1, maxLength: 20 }), (points) => {
        const [[west, south], [east, north]] = productionView(points)!.bounds!;
        for (const [lon, lat] of points) {
          expect(lon).toBeGreaterThan(west);
          expect(lon).toBeLessThan(east);
          expect(lat).toBeGreaterThan(south);
          expect(lat).toBeLessThan(north);
        }
        expect(east - west).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(north - south).toBeGreaterThanOrEqual(4 - 1e-9);
      }),
    );
  });
});

describe("arcPath", () => {
  const point: fc.Arbitrary<[number, number]> = fc.tuple(
    fc.double({ min: 0, max: 960, noNaN: true }),
    fc.double({ min: 0, max: 480, noNaN: true }),
  );

  it("runs from the start to the end and bends up the screen, at most 90px", () => {
    fc.assert(
      fc.property(point, point, (a, b) => {
        const m = /^M(.+),(.+) Q(.+),(.+) (.+),(.+)$/.exec(arcPath(a, b));
        expect(m).not.toBeNull();
        const [x1, y1, cx, cy, x2, y2] = m!.slice(1).map(Number);
        expect([x1, y1, x2, y2]).toEqual([a[0], a[1], b[0], b[1]]);
        const midY = (a[1] + b[1]) / 2;
        expect(cy).toBeLessThanOrEqual(midY + 1e-9);
        expect(Math.hypot(cx - (a[0] + b[0]) / 2, cy - midY)).toBeLessThanOrEqual(90 + 1e-9);
      }),
    );
  });
});

describe("routeStart", () => {
  const site = (isRouteOrigin: boolean) =>
    ({ isRouteOrigin, location: { longitude: 106.7, latitude: 10.8 } }) as MapSite;

  it("prefers the marked origin site, then the profile's country", () => {
    expect(routeStart([site(false), site(true)], "Vietnam")).toEqual({
      at: [106.7, 10.8],
      approximate: false,
    });
    expect(routeStart([site(false)], "Vietnam")).toEqual({ at: [107.6, 16.1], approximate: true });
    expect(routeStart([], "Atlantis")).toBeNull();
  });
});

describe("floodView", () => {
  it("is centred on the flood and wider than the flood plus the check radius", () => {
    const flood = {
      center: { longitude: 106, latitude: 10 },
      radiusKm: 20,
      place: "Binh Duong, Vietnam",
    } as SatelliteObservation;
    const view = floodView(flood, 30);
    const [[west, south], [east, north]] = view.bounds!;
    expect(view.label).toBe("Flood · Vietnam");
    expect((west + east) / 2).toBeCloseTo(106);
    expect((south + north) / 2).toBeCloseTo(10);
    expect(((north - south) / 2) * 110.57).toBeCloseTo(58);
  });
});
