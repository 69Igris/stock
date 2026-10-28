"use client";

import { useEffect, useState } from "react";
import { Loader2, Receipt, Check, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@usemoney/ui/card";
import { Button } from "@usemoney/ui/button";
import {
  getMyGstProfileAction,
  setMyGstProfileAction,
} from "@/lib/actions/gst-profile";
import type { UserGstProfile } from "@usemoney/services/gst";

const STATE_OPTIONS: Array<{ code: string; name: string }> = [
  { code: "01", name: "Jammu & Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "25", name: "Daman & Diu" },
  { code: "26", name: "Dadra & Nagar Haveli" },
  { code: "27", name: "Maharashtra" },
  { code: "28", name: "Andhra Pradesh (old)" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman & Nicobar" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh (new)" },
];

export function GstProfileCard() {
  const [profile, setProfile] = useState<UserGstProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form state
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [gstin, setGstin] = useState("");
  const [pan, setPan] = useState("");

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const res = await getMyGstProfileAction();
      if (res.success && res.data) {
        setProfile(res.data);
        setLegalName(res.data.legalName);
        setAddress(res.data.address);
        setStateCode(res.data.stateCode);
        setGstin(res.data.gstin || "");
        setPan(res.data.pan || "");
      } else if (res.success && !res.data) {
        // First-time visitor - open the editor by default
        setEditing(true);
      }
      setLoading(false);
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const res = await setMyGstProfileAction({
      legalName: legalName.trim(),
      address: address.trim(),
      stateCode,
      gstin: gstin.trim() || undefined,
      pan: pan.trim() || undefined,
    });
    setSaving(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    setProfile(res.data);
    setEditing(false);
    toast.success("GST details saved. Future invoices will use these.");
  };

  if (loading) {
    return (
      <Card id="tax">
        <CardContent className="py-6 flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading GST details...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="tax">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-emerald-400" />
          Tax & GST Details
        </CardTitle>
        <CardDescription>
          Add your GST details to download GST-compliant tax invoices for any
          payment you make on UseMoney.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!editing && profile ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-2 text-emerald-400">
              <Check className="h-4 w-4 mt-0.5" />
              <span>GST details saved.</span>
            </div>
            <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
              <dt className="text-muted-foreground">Legal name</dt>
              <dd>{profile.legalName}</dd>
              <dt className="text-muted-foreground">Address</dt>
              <dd className="whitespace-pre-line">{profile.address}</dd>
              <dt className="text-muted-foreground">State</dt>
              <dd>
                {profile.stateCode}{" "}
                {STATE_OPTIONS.find((s) => s.code === profile.stateCode)?.name}
              </dd>
              {profile.gstin && (
                <>
                  <dt className="text-muted-foreground">GSTIN</dt>
                  <dd className="font-mono">{profile.gstin}</dd>
                </>
              )}
              {profile.pan && (
                <>
                  <dt className="text-muted-foreground">PAN</dt>
                  <dd className="font-mono">{profile.pan}</dd>
                </>
              )}
            </dl>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Update details
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Legal name *
              </label>
              <input
                type="text"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="Your full legal name or registered business name"
                className="w-full rounded-md bg-muted px-3 py-2 text-sm border border-border"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                Registered address *
              </label>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, city, postal code"
                rows={3}
                className="w-full rounded-md bg-muted px-3 py-2 text-sm border border-border"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  State *
                </label>
                <select
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value)}
                  className="w-full rounded-md bg-muted px-3 py-2 text-sm border border-border"
                >
                  <option value="">Select state...</option>
                  {STATE_OPTIONS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.code} - {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  PAN (optional)
                </label>
                <input
                  type="text"
                  value={pan}
                  onChange={(e) => setPan(e.target.value.toUpperCase())}
                  placeholder="ABCDE1234F"
                  maxLength={10}
                  className="w-full rounded-md bg-muted px-3 py-2 text-sm font-mono border border-border"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                GSTIN (optional - required for B2B invoices)
              </label>
              <input
                type="text"
                value={gstin}
                onChange={(e) => setGstin(e.target.value.toUpperCase())}
                placeholder="22AAAAA0000A1Z5"
                maxLength={15}
                className="w-full rounded-md bg-muted px-3 py-2 text-sm font-mono border border-border"
              />
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
              <span>
                These details appear on your tax invoice. Once an invoice is
                issued, the snapshot is frozen - future edits only affect new
                invoices.
              </span>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              {profile && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSave()}
                disabled={
                  saving || !legalName.trim() || !address.trim() || !stateCode
                }
                className="bg-emerald-600 hover:bg-emerald-500"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                Save GST details
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
