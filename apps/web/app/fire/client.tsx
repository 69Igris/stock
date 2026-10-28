"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";

import Sidebar from "@/components/Sidebar";
import { DemoBanner } from "@/components/DemoBanner";

import {
  getFireScenariosAction,
  saveFireScenarioAction,
  deleteFireScenarioAction,
  loadFireScenarioAction,
} from "@/lib/actions/fire";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";
import {
  defaultAssetClasses,
  defaultOneTimeExpenses,
  getDefaultMonthlyExpenses,
} from "./lib/types";
import type {
  AssetClass,
  MonthlyExpense,
  OneTimeExpense,
  SavedScenario,
} from "./lib/types";
import {
  computeWeightedReturn,
  computeAvgInflation,
  computeOneTimeExpensesForFire,
  computeFireNumber,
  computeSwrFireNumber,
  computeYearsToFire,
  computeProjectionData,
  computeSustainableMonthly,
} from "./lib/calculations";
import { ProjectionChartCard } from "./components/ProjectionChartCard";
import { SnapshotCards } from "./components/SnapshotCards";
import { StatusBanner } from "./components/StatusBanner";
import { IndianContextCard } from "./components/IndianContextCard";
import { AssetMixCard } from "./components/AssetMixCard";
import { MonthlyExpensesTable } from "./components/MonthlyExpensesTable";
import { OneTimeGoalsTable } from "./components/OneTimeGoalsTable";
import { FireHeader } from "./components/FireHeader";
import { ScenarioBar } from "./components/ScenarioBar";
import { PlanInputsPanel } from "./components/PlanInputsPanel";
import { WhatIfGrid } from "./components/WhatIfGrid";
import AskFirePanel from "./components/AskFirePanel";
import { FireActionsProvider } from "./lib/chat/FireActionsContext";
import {
  buildFireActions,
  buildFireSnapshot,
  rebalanceAssetAllocations,
  type FireLive,
} from "./lib/chat/bridge";
import "./fire-playful.css";

/* =====================================================================
   FIRE page
   ===================================================================== */

export default function FirePageClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  // React 18.3-safe pending flag. (Previously useTransition + async
  // startTransition — the React 19 "Actions" pattern — which trips React's
  // async-info/Suspense invariant under Next 16. Plain state, same isPending UX.)
  const [isPending, setIsPending] = useState(false);

  const isDemoMode = useIsDemoMode({ user });
  const demoModeReady = useIsDemoModeReady();

  /* ── Inputs ── */
  const [currentAge, setCurrentAge] = useState(30);
  const [retirementAge, setRetirementAge] = useState(50);
  const [lifeExpectancy, setLifeExpectancy] = useState(85);
  const [currentCorpus, setCurrentCorpus] = useState(1_800_000);
  const [monthlySavings, setMonthlySavings] = useState(60_000);
  const [withdrawalRate, setWithdrawalRate] = useState(4);
  const [taxRate, setTaxRate] = useState(30);
  const [savingsIncrement, setSavingsIncrement] = useState(8);
  const [salaryIncrement, setSalaryIncrement] = useState(10);

  const [assetClasses, setAssetClasses] = useState<AssetClass[]>(
    defaultAssetClasses.map((a) => ({ ...a }))
  );
  const [monthlyExpenses, setMonthlyExpenses] = useState<MonthlyExpense[]>(
    getDefaultMonthlyExpenses()
  );
  const [oneTimeExpenses, setOneTimeExpenses] = useState<OneTimeExpense[]>(
    defaultOneTimeExpenses
  );

  /* ── Scenarios ── */
  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [scenarioName, setScenarioName] = useState("Default plan");

  const loadSavedScenarios = useCallback(async () => {
    const result = await getFireScenariosAction();
    if (result?.success && result?.data) {
      setSavedScenarios(
        result.data.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }))
      );
    }
  }, []);

  const loadSavedScenariosRef = useRef(loadSavedScenarios);
  loadSavedScenariosRef.current = loadSavedScenarios;

  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) {
      router.push("/home");
      return;
    }
    void loadSavedScenariosRef.current();
  }, [isLoaded, demoModeReady, user, isDemoMode, router]);

  const switchToScenario = async (id: string) => {
    setIsPending(true);
    try {
      const result = await loadFireScenarioAction(id);
      if (result?.success && result?.data) {
        const s = result.data;
        setCurrentAge(s.currentAge);
        setRetirementAge(s.retirementAge);
        setLifeExpectancy(s.lifeExpectancy);
        setCurrentCorpus(s.currentCorpus);
        setMonthlySavings(s.monthlySavings);
        setWithdrawalRate(s.withdrawalRate);
        setTaxRate(s.taxRate ?? 30);
        setSalaryIncrement(s.salaryIncrement);
        setSavingsIncrement(s.savingsIncrement);
        setAssetClasses(s.assetClasses as unknown as AssetClass[]);
        setMonthlyExpenses(
          (s.expenses as unknown as MonthlyExpense[]) ||
            getDefaultMonthlyExpenses()
        );
        setOneTimeExpenses(
          (s.oneTimeExpenses as unknown as OneTimeExpense[]) || []
        );
        setActiveScenarioId(s.id);
        setScenarioName(s.name);
      } else {
        toast.error(result?.error || "Failed to load");
      }
    } finally {
      setIsPending(false);
    }
  };

  const cloneScenario = async () => {
    setActiveScenarioId(null);
    setScenarioName(`${scenarioName} · copy`);
    toast.success("Scenario duplicated - save to keep changes");
  };

  const deleteScenario = async () => {
    if (!activeScenarioId) return;
    setIsPending(true);
    try {
      const result = await deleteFireScenarioAction(activeScenarioId);
      if (result?.success) {
        toast.success("Scenario deleted");
        setActiveScenarioId(null);
        await loadSavedScenarios();
      } else {
        toast.error(result?.error || "Failed to delete");
      }
    } finally {
      setIsPending(false);
    }
  };

  /* ── Derived ── */
  const monthlyExpToday = useMemo(
    () => monthlyExpenses.reduce((s, e) => s + e.amount, 0),
    [monthlyExpenses]
  );
  const annualExpToday = monthlyExpToday * 12;
  const avgInflation = useMemo(
    () => computeAvgInflation(monthlyExpenses),
    [monthlyExpenses]
  );
  const weightedReturn = useMemo(
    () => computeWeightedReturn(assetClasses),
    [assetClasses]
  );

  const oneTimeForFire = useMemo(
    () =>
      computeOneTimeExpensesForFire(
        oneTimeExpenses,
        retirementAge,
        currentAge,
        weightedReturn,
        taxRate
      ),
    [oneTimeExpenses, retirementAge, currentAge, weightedReturn, taxRate]
  );

  const fireNumber = useMemo(
    () =>
      computeFireNumber(
        monthlyExpToday,
        avgInflation,
        weightedReturn,
        taxRate,
        retirementAge,
        currentAge,
        lifeExpectancy,
        oneTimeForFire
      ),
    [
      monthlyExpToday,
      avgInflation,
      weightedReturn,
      taxRate,
      retirementAge,
      currentAge,
      lifeExpectancy,
      oneTimeForFire,
    ]
  );

  // Perpetual "4% rule" comparison number (uses the withdrawal-rate slider).
  const swrFireNumber = useMemo(
    () =>
      computeSwrFireNumber(
        monthlyExpToday,
        avgInflation,
        withdrawalRate,
        retirementAge,
        currentAge,
        oneTimeForFire
      ),
    [
      monthlyExpToday,
      avgInflation,
      withdrawalRate,
      retirementAge,
      currentAge,
      oneTimeForFire,
    ]
  );

  const yearsToFire = useMemo(
    () =>
      computeYearsToFire(
        currentCorpus,
        monthlySavings,
        fireNumber,
        weightedReturn,
        savingsIncrement,
        retirementAge,
        currentAge,
        monthlyExpToday,
        avgInflation,
        taxRate,
        withdrawalRate,
        oneTimeExpenses
      ),
    [
      currentCorpus,
      monthlySavings,
      fireNumber,
      weightedReturn,
      savingsIncrement,
      retirementAge,
      currentAge,
      monthlyExpToday,
      avgInflation,
      taxRate,
      withdrawalRate,
      oneTimeExpenses,
    ]
  );

  const projection = useMemo(
    () =>
      computeProjectionData(
        currentAge,
        retirementAge,
        currentCorpus,
        monthlySavings,
        monthlyExpToday,
        avgInflation,
        weightedReturn,
        taxRate,
        withdrawalRate,
        lifeExpectancy,
        yearsToFire,
        savingsIncrement,
        oneTimeExpenses
      ),
    [
      currentAge,
      retirementAge,
      currentCorpus,
      monthlySavings,
      monthlyExpToday,
      avgInflation,
      weightedReturn,
      taxRate,
      withdrawalRate,
      lifeExpectancy,
      yearsToFire,
      savingsIncrement,
      oneTimeExpenses,
    ]
  );

  const corpusAtRetire =
    projection.find((p) => p.age === retirementAge)?.corpus ?? 0;
  const fireNumAtRetire =
    projection.find((p) => p.age === retirementAge)?.fireNumber ?? fireNumber;
  const fireAchieved = corpusAtRetire >= fireNumAtRetire;
  const surplus = corpusAtRetire - fireNumAtRetire;
  // The projection always runs the corpus to life expectancy (it's clamped at
  // ≥ 0 each year and the loop only breaks at age >= lifeExpectancy), so this
  // is effectively the plan horizon — used only for the "money lasts till N"
  // ON-TRACK copy. It is NOT a failure signal (the corpus never "runs out"
  // under the MONEY-876 withdrawal cap); `firstShortfallAge` is.
  const corpusLastsTill =
    projection[projection.length - 1]?.age ?? lifeExpectancy;
  // First retirement year where spending exceeds the withdrawal-rate cap.
  const firstShortfallAge =
    projection.find((p) => (p.shortfall ?? 0) > 0)?.age ?? null;
  const sustainableMonthly = computeSustainableMonthly(
    corpusAtRetire,
    avgInflation,
    weightedReturn,
    taxRate,
    retirementAge,
    lifeExpectancy
  );

  const allocSum = assetClasses.reduce((s, a) => s + a.allocation, 0);
  const allocOff = Math.abs(allocSum - 100) > 0.5;

  // On track = FIRE corpus reached at retirement AND every retirement year is
  // fully funded. Under the MONEY-876 withdrawal cap the corpus can never
  // technically hit zero (you never draw more than the cap), so "runs out" is
  // not a reachable state — an unfunded shortfall year (firstShortfallAge) is
  // the real failure signal. Three states total: ON TRACK / BEHIND / OVERDRAWN.
  const statusOk = fireAchieved && firstShortfallAge === null;

  const updateAsset = (id: string, patch: Partial<AssetClass>) =>
    setAssetClasses((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch } : a))
    );

  const updateExpense = (id: string, patch: Partial<MonthlyExpense>) =>
    setMonthlyExpenses((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...patch } : e))
    );

  const removeExpense = (id: string) =>
    setMonthlyExpenses((prev) => prev.filter((e) => e.id !== id));

  const addExpense = () =>
    setMonthlyExpenses((prev) => [
      ...prev,
      {
        id: `exp_${Date.now()}`,
        category: "New category",
        amount: 5000,
        inflation: 6,
      },
    ]);

  const updateOneTime = (id: string, patch: Partial<OneTimeExpense>) =>
    setOneTimeExpenses((prev) =>
      prev.map((o) => (o.id === id ? { ...o, ...patch } : o))
    );
  const removeOneTime = (id: string) =>
    setOneTimeExpenses((prev) => prev.filter((o) => o.id !== id));
  const addOneTime = () =>
    setOneTimeExpenses((prev) => [
      ...prev,
      {
        id: `ot_${Date.now()}`,
        name: "New goal",
        currentCost: 1_000_000,
        yearsAway: 5,
        inflation: 6,
      },
    ]);

  const handleSave = async () => {
    setIsPending(true);
    try {
      const result = await saveFireScenarioAction(
        {
          name: scenarioName,
          description: undefined,
          currentAge,
          retirementAge,
          lifeExpectancy,
          currentCorpus,
          monthlySavings,
          withdrawalRate,
          taxRate,
          salaryIncrement,
          savingsIncrement,
          assetClasses: assetClasses as unknown as never[],
          expenses: monthlyExpenses as unknown as never[],
          oneTimeExpenses: oneTimeExpenses as unknown as never[],
          fireNumber,
          yearsToFire: yearsToFire >= 999 ? null : yearsToFire,
          avgInflation,
          weightedReturn,
        },
        activeScenarioId ?? undefined
      );
      if (result?.success) {
        toast.success(`Saved: ${scenarioName}`);
        if (result?.data) setActiveScenarioId(result.data.id);
        await loadSavedScenarios();
      } else {
        toast.error(result?.error || "Failed to save");
      }
    } finally {
      setIsPending(false);
    }
  };

  // Reset the active plan to factory defaults. Shared by the inputs-panel
  // Reset button and the chat's `resetAll` tool.
  const resetAll = () => {
    setCurrentAge(30);
    setRetirementAge(50);
    setLifeExpectancy(85);
    setCurrentCorpus(1_800_000);
    setMonthlySavings(60_000);
    setWithdrawalRate(4);
    setTaxRate(30);
    setSavingsIncrement(8);
    setSalaryIncrement(10);
    setAssetClasses(defaultAssetClasses.map((a) => ({ ...a })));
    setMonthlyExpenses(getDefaultMonthlyExpenses());
    setOneTimeExpenses(defaultOneTimeExpenses);
  };

  /* ── Ask FIRE chat bridge (MONEY-1049) ──────────────────────────────
     Expose the plan state + mutators to the chat's tool executor. The
     chat's "save scenario" creates a NEW named scenario; "load" resolves
     a saved scenario by name and switches to it. */
  const chatSaveScenario = async (name: string): Promise<boolean> => {
    setScenarioName(name);
    setIsPending(true);
    try {
      const result = await saveFireScenarioAction({
        name,
        description: undefined,
        currentAge,
        retirementAge,
        lifeExpectancy,
        currentCorpus,
        monthlySavings,
        withdrawalRate,
        taxRate,
        salaryIncrement,
        savingsIncrement,
        assetClasses: assetClasses as unknown as never[],
        expenses: monthlyExpenses as unknown as never[],
        oneTimeExpenses: oneTimeExpenses as unknown as never[],
        fireNumber,
        yearsToFire: yearsToFire >= 999 ? null : yearsToFire,
        avgInflation,
        weightedReturn,
      });
      if (result?.success) {
        toast.success(`Saved: ${name}`);
        if (result?.data) setActiveScenarioId(result.data.id);
        await loadSavedScenarios();
        return true;
      }
      toast.error(result?.error || "Failed to save");
      return false;
    } finally {
      setIsPending(false);
    }
  };

  const chatLoadScenarioByName = async (name: string): Promise<boolean> => {
    const match = savedScenarios.find(
      (s) => s.name.toLowerCase() === name.toLowerCase()
    );
    if (!match) return false;
    await switchToScenario(match.id);
    return true;
  };

  // Latest-value ref so the chat bridge (built once, below) always reads
  // and writes the current render's state — no stale closures, no churn.
  // Mirrors the existing `loadSavedScenariosRef` pattern above.
  const liveRef = useRef<FireLive | null>(null);
  liveRef.current = {
    currentAge,
    retirementAge,
    lifeExpectancy,
    currentCorpus,
    monthlySavings,
    withdrawalRate,
    taxRate,
    salaryIncrement,
    savingsIncrement,
    assetClasses,
    monthlyExpenses,
    oneTimeExpenses,
    savedScenarios,
    fireNumber,
    yearsToFire,
    corpusAtRetire,
    fireAchieved,
    surplus,
    corpusLastsTill,
    sustainableMonthly,
    swrFireNumber,
    firstShortfallAge,
    setCurrentAge,
    setRetirementAge,
    setLifeExpectancy,
    setCurrentCorpus,
    setMonthlySavings,
    setWithdrawalRate,
    setTaxRate,
    setSalaryIncrement,
    setSavingsIncrement,
    setAssetClasses,
    setMonthlyExpenses,
    setOneTimeExpenses,
    saveScenario: chatSaveScenario,
    loadScenarioByName: chatLoadScenarioByName,
    resetAll,
  };

  const fireChat = useMemo(
    () => ({
      actions: buildFireActions(() => liveRef.current as FireLive),
      getSnapshot: () => buildFireSnapshot(liveRef.current as FireLive),
      rebalanceAllocations: (preserveNames: string[]) =>
        (liveRef.current as FireLive).setAssetClasses((prev) =>
          rebalanceAssetAllocations(prev, preserveNames)
        ),
    }),
    []
  );

  // FIRE is an always-on (ungated) page — no PageGuard. The route-level
  // app/fire/loading.tsx already renders the loading skeleton during SSR.
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />

      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-4 sm:p-6 pb-24">
          {isDemoMode && <DemoBanner />}

          {/* ── Page heading ── */}
          <FireHeader
            onClone={cloneScenario}
            onSave={handleSave}
            isPending={isPending}
          />

          {/* ── Scenario bar ── */}
          <ScenarioBar
            savedScenarios={savedScenarios}
            activeScenarioId={activeScenarioId}
            scenarioName={scenarioName}
            isPending={isPending}
            onSwitch={switchToScenario}
            onNew={() => {
              setActiveScenarioId(null);
              setScenarioName("New plan");
            }}
            onRename={setScenarioName}
            onDelete={deleteScenario}
          />

          <SnapshotCards
            fireNumber={fireNumber}
            swrFireNumber={swrFireNumber}
            withdrawalRate={withdrawalRate}
            firstShortfallAge={firstShortfallAge}
            projection={projection}
            retirementAge={retirementAge}
            corpusAtRetire={corpusAtRetire}
            surplus={surplus}
            yearsToFire={yearsToFire}
            currentAge={currentAge}
            sustainableMonthly={sustainableMonthly}
            weightedReturn={weightedReturn}
            taxRate={taxRate}
            statusOk={statusOk}
            fireAchieved={fireAchieved}
          />

          {/* ── Status banner ── */}
          <StatusBanner
            statusOk={statusOk}
            fireAchieved={fireAchieved}
            surplus={surplus}
            corpusLastsTill={corpusLastsTill}
            currentAge={currentAge}
            yearsToFire={yearsToFire}
            retirementAge={retirementAge}
            firstShortfallAge={firstShortfallAge}
            onBumpSip={() =>
              setMonthlySavings(Math.round(monthlySavings * 1.25))
            }
            onDeferRetire={() => setRetirementAge(retirementAge + 3)}
          />

          {/* ── Main 2-column grid ── */}
          <div className="pf-fire-main-grid">
            {/* LEFT COLUMN */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 18,
                minWidth: 0,
              }}
            >
              {/* 02 · TUNE — Corpus projection chart */}
              <ProjectionChartCard
                projection={projection}
                retirementAge={retirementAge}
                oneTimeExpenses={oneTimeExpenses}
                fireNumAtRetire={fireNumAtRetire}
                currentAge={currentAge}
                lifeExpectancy={lifeExpectancy}
                weightedReturn={weightedReturn}
              />

              {/* 03 · MILESTONES */}
              <IndianContextCard
                annualExpToday={annualExpToday}
                projection={projection}
                currentAge={currentAge}
              />

              {/* 04 · ASSET ALLOCATION */}
              <AssetMixCard
                assetClasses={assetClasses}
                weightedReturn={weightedReturn}
                allocOff={allocOff}
                allocSum={allocSum}
                onUpdateAsset={updateAsset}
              />

              {/* 05 · EXPENSES */}
              <MonthlyExpensesTable
                monthlyExpenses={monthlyExpenses}
                monthlyExpToday={monthlyExpToday}
                currentAge={currentAge}
                retirementAge={retirementAge}
                onUpdate={updateExpense}
                onRemove={removeExpense}
                onAdd={addExpense}
              />

              {/* 06 · GOALS */}
              <OneTimeGoalsTable
                oneTimeExpenses={oneTimeExpenses}
                onUpdate={updateOneTime}
                onRemove={removeOneTime}
                onAdd={addOneTime}
              />

              {/* 07 · WHAT-IF */}
              <WhatIfGrid
                monthlySavings={monthlySavings}
                retirementAge={retirementAge}
                setMonthlySavings={setMonthlySavings}
                setRetirementAge={setRetirementAge}
                setSavingsIncrement={setSavingsIncrement}
                setMonthlyExpenses={setMonthlyExpenses}
                setAssetClasses={setAssetClasses}
              />
            </div>

            {/* RIGHT COLUMN — sticky inputs panel */}
            <PlanInputsPanel
              currentAge={currentAge}
              retirementAge={retirementAge}
              lifeExpectancy={lifeExpectancy}
              currentCorpus={currentCorpus}
              monthlySavings={monthlySavings}
              savingsIncrement={savingsIncrement}
              withdrawalRate={withdrawalRate}
              taxRate={taxRate}
              salaryIncrement={salaryIncrement}
              monthlyExpToday={monthlyExpToday}
              weightedReturn={weightedReturn}
              setCurrentAge={setCurrentAge}
              setRetirementAge={setRetirementAge}
              setLifeExpectancy={setLifeExpectancy}
              setCurrentCorpus={setCurrentCorpus}
              setMonthlySavings={setMonthlySavings}
              setSavingsIncrement={setSavingsIncrement}
              setWithdrawalRate={setWithdrawalRate}
              setTaxRate={setTaxRate}
              setSalaryIncrement={setSalaryIncrement}
              onReset={resetAll}
            />
          </div>
        </div>
      </main>

      {/* Ask FIRE — slide-in chat sidebar. MONEY-1049 wires it to the plan
          state via FireActionsProvider so the chat can drive the inputs. */}
      <FireActionsProvider value={fireChat}>
        <AskFirePanel />
      </FireActionsProvider>
    </div>
  );
}
