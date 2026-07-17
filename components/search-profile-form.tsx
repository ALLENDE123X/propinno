"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Loader2 } from "lucide-react"
import { CriteriaFormFields, type CriteriaFormValues } from "@/components/criteria-form-fields"

type CriteriaApiResponse = {
  priceMin: number | null
  priceMax: number | null
  bedsMin: number | null
  bedsMax: number | null
  bathsMin: number | null
  bathsMax: number | null
  zips: string[] | null
  neighborhoods: string[] | null
  pets: string | null
  laundry: string | null
  commuteAddress: string | null
  commuteMaxMinutes: number | null
  commuteMode: string | null
}

const EMPTY_VALUES: CriteriaFormValues = {
  priceMin: "",
  priceMax: "",
  bedsMin: "",
  bedsMax: "",
  bathsMin: "",
  bathsMax: "",
  pets: "",
  laundry: "",
  commuteAddress: "",
  commuteMaxMinutes: "",
  commuteMode: "",
  locations: "",
}

function toFormValues(c: CriteriaApiResponse): CriteriaFormValues {
  return {
    priceMin: c.priceMin !== null ? String(c.priceMin) : "",
    priceMax: c.priceMax !== null ? String(c.priceMax) : "",
    bedsMin: c.bedsMin !== null ? String(c.bedsMin) : "",
    bedsMax: c.bedsMax !== null ? String(c.bedsMax) : "",
    bathsMin: c.bathsMin !== null ? String(c.bathsMin) : "",
    bathsMax: c.bathsMax !== null ? String(c.bathsMax) : "",
    pets: c.pets ?? "",
    laundry: c.laundry ?? "",
    commuteAddress: c.commuteAddress ?? "",
    commuteMaxMinutes: c.commuteMaxMinutes !== null ? String(c.commuteMaxMinutes) : "",
    commuteMode: c.commuteMode ?? "",
    // Same comma-joined single-input convention onboarding-flow.tsx's own
    // NLP-fill path uses (see its handleParseDescription) - neighborhoods
    // first, then zips - split back apart on save by the same 5-digit-zip
    // regex both forms use.
    locations: [...(c.neighborhoods ?? []), ...(c.zips ?? [])].join(", "),
  }
}

// AH-026. Client component for /dashboard/profile - competitive parity with
// AH3000's "Search Profile" section (docs/AH3000_teardown.md): lets a
// subscriber edit the criteria they set at onboarding (components/
// onboarding-flow.tsx) any time afterward, not just once. Fetches via
// GET /api/criteria on mount (same pattern as components/favourites-list.tsx/
// inbox-list.tsx) rather than a Server Component prop-fetch, since this page
// also needs the PATCH round-trip on save and keeping both on the same
// client-fetch code path avoids two different data-loading conventions for
// the same resource.
export function SearchProfileForm() {
  const [values, setValues] = useState<CriteriaFormValues>(EMPTY_VALUES)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/criteria")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load your search profile")
        return res.json()
      })
      .then((data) => {
        setValues(toFormValues(data.criteria))
        setError(null)
      })
      .catch(() => {
        setError("Couldn't load your search profile. Try again shortly.")
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  const handleFieldChange = (key: keyof CriteriaFormValues, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const locationList = values.locations.split(",").map((l) => l.trim()).filter(Boolean)
      const zips = locationList.filter((l) => /^\d{5}$/.test(l))
      const neighborhoods = locationList.filter((l) => !/^\d{5}$/.test(l))

      // Every field is sent explicitly (a real value or null), unlike
      // onboarding's "omit if empty" convention - this is an edit surface,
      // so an emptied field must actively clear the previously-saved value
      // rather than leaving it untouched. See app/api/criteria/route.ts's
      // header comment for the server-side half of this contract.
      const body = {
        priceMin: values.priceMin ? Number(values.priceMin) : null,
        priceMax: values.priceMax ? Number(values.priceMax) : null,
        bedsMin: values.bedsMin ? Number(values.bedsMin) : null,
        bedsMax: values.bedsMax ? Number(values.bedsMax) : null,
        bathsMin: values.bathsMin ? Number(values.bathsMin) : null,
        bathsMax: values.bathsMax ? Number(values.bathsMax) : null,
        zips: zips.length > 0 ? zips : null,
        neighborhoods: neighborhoods.length > 0 ? neighborhoods : null,
        pets: values.pets || null,
        laundry: values.laundry || null,
        commuteAddress: values.commuteAddress || null,
        commuteMaxMinutes: values.commuteMaxMinutes ? Number(values.commuteMaxMinutes) : null,
        commuteMode: values.commuteMode || null,
      }

      const res = await fetch("/api/criteria", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save your search profile")

      toast.success(
        data.commuteRecomputed
          ? "Search profile saved — commute zone recalculated"
          : "Search profile saved"
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save your search profile")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen w-full bg-black p-6 py-12 flex flex-col items-center">
      <div className="w-full max-w-md">
        <Link href="/dashboard" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white text-sm mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to map
        </Link>

        <h1 className="text-2xl font-bold text-white mb-1">Search profile</h1>
        <p className="text-zinc-400 mb-8">Update your saved criteria — we&apos;ll only text you listings that match.</p>

        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800 shadow-xl shadow-black/50">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              {error && (
                <div className="rounded-lg bg-red-900/90 p-3 text-center text-sm text-white">{error}</div>
              )}

              <CriteriaFormFields values={values} onChange={handleFieldChange} />

              <Button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="w-full bg-white text-black hover:bg-zinc-200 mt-2 font-semibold h-11"
              >
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Save changes
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
