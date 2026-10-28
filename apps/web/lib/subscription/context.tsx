'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { PlanType, UserSubscription, getDefaultSubscription, PLANS, canAccessFeature } from './types'

interface SubscriptionContextType {
  subscription: UserSubscription
  isLoading: boolean
  currentPlan: typeof PLANS[PlanType]
  canAccess: (feature: string) => boolean
  remainingAIQueries: number
  useAIQuery: () => boolean
  upgradePlan: (planId: PlanType) => Promise<void>
  addAddon: (addonId: string) => Promise<void>
  refreshSubscription: () => void
}

const SubscriptionContext = createContext<SubscriptionContextType | undefined>(undefined)

const STORAGE_KEY = 'tradebook_subscription'

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [subscription, setSubscription] = useState<UserSubscription>(getDefaultSubscription())
  const [isLoading, setIsLoading] = useState(true)

  // Load subscription from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        setSubscription(JSON.parse(saved))
      } catch (e) {
        console.error('Failed to parse subscription')
      }
    }
    setIsLoading(false)
  }, [])

  // Save subscription to localStorage
  const saveSubscription = (sub: UserSubscription) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sub))
    setSubscription(sub)
  }

  const currentPlan = PLANS[subscription.planId]

  const canAccess = (feature: string): boolean => {
    // Check main plan
    if (canAccessFeature(feature, subscription.planId)) return true
    
    // Check addons
    for (const addon of subscription.addons) {
      if (canAccessFeature(feature, addon as PlanType)) return true
    }
    
    return false
  }

  const remainingAIQueries = subscription.aiQueriesLimit === -1 
    ? Infinity 
    : subscription.aiQueriesLimit - subscription.aiQueriesUsed

  const useAIQuery = (): boolean => {
    if (subscription.aiQueriesLimit === -1) return true // Unlimited
    if (remainingAIQueries <= 0) return false
    
    const updated = {
      ...subscription,
      aiQueriesUsed: subscription.aiQueriesUsed + 1
    }
    saveSubscription(updated)
    return true
  }

  const upgradePlan = async (planId: PlanType): Promise<void> => {
    // In real implementation, this would call the payment API
    const plan = PLANS[planId]
    const updated: UserSubscription = {
      ...subscription,
      planId,
      status: 'active',
      startDate: new Date().toISOString(),
      aiQueriesLimit: plan.aiQueries,
      aiQueriesUsed: 0,
    }
    saveSubscription(updated)
  }

  const addAddon = async (addonId: string): Promise<void> => {
    const updated = {
      ...subscription,
      addons: [...subscription.addons, addonId],
      aiQueriesLimit: subscription.aiQueriesLimit + (PLANS[addonId as PlanType]?.aiQueries || 0),
    }
    saveSubscription(updated)
  }

  const refreshSubscription = () => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        setSubscription(JSON.parse(saved))
      } catch (e) {
        console.error('Failed to refresh subscription')
      }
    }
  }

  return (
    <SubscriptionContext.Provider value={{
      subscription,
      isLoading,
      currentPlan,
      canAccess,
      remainingAIQueries,
      useAIQuery,
      upgradePlan,
      addAddon,
      refreshSubscription,
    }}>
      {children}
    </SubscriptionContext.Provider>
  )
}

export function useSubscription() {
  const context = useContext(SubscriptionContext)
  if (!context) {
    throw new Error('useSubscription must be used within a SubscriptionProvider')
  }
  return context
}
