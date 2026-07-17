"use client";

// AH-026. Shared criteria input fields, extracted from
// components/onboarding-flow.tsx so the "edit your search profile after
// signup" page (components/search-profile-form.tsx) doesn't duplicate this
// JSX wholesale. Deliberately just the field markup + a value-bag/onChange
// contract - no fetch/submit logic lives here, since onboarding and the
// profile-edit page save criteria through two different endpoints
// (POST /api/auth/verify-otp at signup vs. PATCH /api/criteria after) and
// have different surrounding page chrome. Kept to this one component rather
// than a bigger shared-form abstraction - it's fundamentally two forms
// sharing a field list, not two flows sharing behavior.
export type CriteriaFormValues = {
  priceMin: string;
  priceMax: string;
  bedsMin: string;
  bedsMax: string;
  bathsMin: string;
  bathsMax: string;
  pets: string;
  laundry: string;
  commuteAddress: string;
  commuteMaxMinutes: string;
  commuteMode: string;
  // Comma-separated neighborhoods/zips, matching onboarding's existing single
  // free-text input convention - split into the two DB array columns by
  // caller (5-digit numeric = zip, else neighborhood), same regex both
  // components/onboarding-flow.tsx and components/search-profile-form.tsx use.
  locations: string;
};

type Props = {
  values: CriteriaFormValues;
  onChange: (key: keyof CriteriaFormValues, value: string) => void;
};

export function CriteriaFormFields({ values, onChange }: Props) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Min Price</label>
          <input
            type="number"
            value={values.priceMin}
            onChange={(e) => onChange("priceMin", e.target.value)}
            placeholder="$2,000"
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Max Price</label>
          <input
            type="number"
            value={values.priceMax}
            onChange={(e) => onChange("priceMax", e.target.value)}
            placeholder="$4,000"
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Min Beds</label>
          <input
            type="number"
            value={values.bedsMin}
            onChange={(e) => onChange("bedsMin", e.target.value)}
            placeholder="1"
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Max Beds</label>
          <input
            type="number"
            value={values.bedsMax}
            onChange={(e) => onChange("bedsMax", e.target.value)}
            placeholder="2"
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Min Baths</label>
          <input
            type="number"
            step="0.5"
            value={values.bathsMin}
            onChange={(e) => onChange("bathsMin", e.target.value)}
            placeholder="1"
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Max Baths</label>
          <input
            type="number"
            step="0.5"
            value={values.bathsMax}
            onChange={(e) => onChange("bathsMax", e.target.value)}
            placeholder="2"
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Pets (optional)</label>
          <select
            value={values.pets}
            onChange={(e) => onChange("pets", e.target.value)}
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-zinc-600"
          >
            <option value="">No preference</option>
            <option value="cats">Cat-friendly</option>
            <option value="dogs">Dog-friendly</option>
            <option value="cats_and_dogs">Cats &amp; dogs</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Laundry (optional)</label>
          <select
            value={values.laundry}
            onChange={(e) => onChange("laundry", e.target.value)}
            className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-zinc-600"
          >
            <option value="">No preference</option>
            <option value="in_unit">In-unit washer/dryer</option>
            <option value="on_site">On-site laundry</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1">Where do you work? (optional)</label>
        <input
          type="text"
          value={values.commuteAddress}
          onChange={(e) => onChange("commuteAddress", e.target.value)}
          placeholder="123 Market St, San Francisco, CA"
          className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
        />
      </div>

      {values.commuteAddress && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Max commute (min)</label>
            <input
              type="number"
              value={values.commuteMaxMinutes}
              onChange={(e) => onChange("commuteMaxMinutes", e.target.value)}
              placeholder="30"
              className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Commute mode</label>
            <select
              value={values.commuteMode}
              onChange={(e) => onChange("commuteMode", e.target.value)}
              className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-zinc-600"
            >
              <option value="">Select mode</option>
              <option value="drive">Driving</option>
              <option value="bike">Biking</option>
              <option value="transit">Transit (estimated)</option>
            </select>
          </div>
        </div>
      )}

      {values.commuteAddress && values.commuteMode === "transit" && (
        <p className="text-xs text-zinc-500 -mt-2">
          Transit commute times are a rough estimate, not real transit routing — Mapbox (our mapping provider) doesn&apos;t offer public-transit directions, so this is approximated from walking speed. Treat it as a guide, not a guarantee.
        </p>
      )}

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1">Neighborhoods or Zips (comma separated)</label>
        <input
          type="text"
          value={values.locations}
          onChange={(e) => onChange("locations", e.target.value)}
          placeholder="Marina, 94123, Mission"
          className="w-full bg-black border border-zinc-700 rounded-md px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-600"
        />
      </div>
    </>
  );
}
