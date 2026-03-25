"use client";

/**
 * Admin API keys: configure provider credentials for the deployment.
 */

import { useState, useEffect } from "react";
import { useAuth } from "@/components/AuthProvider";

export default function AdminKeysPage() {
  const { user, loading: authLoading, authReady, isAdmin } = useAuth();
  const [keys, setKeys] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [keyValues, setKeyValues] = useState({
    chatgpt: "",
    claude: "",
    grok: "",
    perplexity: "",
  });

  const [showKeys, setShowKeys] = useState({
    chatgpt: false,
    claude: false,
    grok: false,
    perplexity: false,
  });

  useEffect(() => {
    console.log("[admin/keys] Auth state:", {
      hasUser: !!user,
      isAdmin,
      authLoading,
      userEmail: user?.email,
    });

    // Wait for auth to finish loading
    if (authLoading) {
      console.log("[admin/keys] Auth still loading, waiting...");
      return;
    }

    // Only load keys if user is admin
    if (!isAdmin) {
      console.log("[admin/keys] User is not admin, not loading keys");
      setLoading(false);
      return;
    }

    if (!user) {
      console.error("[admin/keys] No user available");
      setError("Not authenticated. Please sign in.");
      setLoading(false);
      return;
    }

    console.log("[admin/keys] User is admin, loading keys");
    loadKeys();
  }, [isAdmin, authLoading, user]);

  const loadKeys = async () => {
    if (!user) {
      setError("Not authenticated. Please sign in.");
      setLoading(false);
      return;
    }

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");
      console.log("[admin/keys] Fetching keys");

        const response = await authedFetch("/api/admin/keys", {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });

      if (response.status === 401) {
        const errorData = await response.json().catch(() => ({}));
        console.error("[admin/keys] Unauthorized:", errorData);
        setError("Your session may have expired. Please refresh the page or sign in again.");
        setLoading(false);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to load keys");
      }

      const data = await response.json();
      console.log("[admin/keys] Response data:", data);
      console.log("[admin/keys] Status object:", data.status);
      
      if (!data.status) {
        console.error("[admin/keys] No status object in response:", data);
        setError("Invalid response from server. Please try again.");
        setLoading(false);
        return;
      }

      setKeys(data.status);
      setKeyValues({
        chatgpt: "",
        claude: "",
        grok: "",
        perplexity: "",
      });
      setError(""); // Clear any previous errors
      console.log("[admin/keys] Keys loaded successfully:", {
        chatgpt: data.status.chatgpt?.configured,
        claude: data.status.claude?.configured,
        grok: data.status.grok?.configured,
        perplexity: data.status.perplexity?.configured,
      });
    } catch (err: any) {
      console.error("[admin/keys] Error loading keys:", err);
      setError(err.message || "Failed to load keys. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user) {
      setError("Not authenticated. Please sign in.");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const updates: Record<string, string | null> = {};
      if (keyValues.chatgpt) updates.chatgpt = keyValues.chatgpt;
      if (keyValues.claude) updates.claude = keyValues.claude;
      if (keyValues.grok) updates.grok = keyValues.grok;
      if (keyValues.perplexity) updates.perplexity = keyValues.perplexity;

      const response = await authedFetch("/api/admin/keys", {
        user,
        authReady,
        method: "POST",
        body: JSON.stringify(updates),
      });

      if (response.status === 401) {
        const errorData = await response.json().catch(() => ({}));
        setError("Your session may have expired. Please refresh the page or sign in again.");
        setSaving(false);
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to save keys");
      }

      setSuccess("Keys saved successfully!");
      await loadKeys();
    } catch (err: any) {
      console.error("[admin/keys] Error saving keys:", err);
      setError(err.message || "Failed to save keys");
    } finally {
      setSaving(false);
    }
  };

  // Show loading while auth is being determined
  if (authLoading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        <p className="text-sm tracking-wide">Checking admin access…</p>
      </div>
    );
  }

  // If not admin, layout will handle redirect, but show nothing here
  if (!isAdmin) {
    return null;
  }

  const models = [
    { id: "chatgpt" as const, label: "OpenAI API Key (ChatGPT)" },
    { id: "claude" as const, label: "Anthropic API Key (Claude)" },
    { id: "grok" as const, label: "X.AI API Key (Grok)" },
    { id: "perplexity" as const, label: "Perplexity API Key" },
  ];

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        <p className="text-sm tracking-wide">Loading ConvergePanel…</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">API Key Management</h1>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-sm text-green-800">{success}</p>
        </div>
      )}

      <div className="space-y-6">
        {models.map((model) => {
          const status = keys?.[model.id];
          const isConfigured = status?.configured || false;
          const isShowing = showKeys[model.id];
          const currentValue = keyValues[model.id];

          return (
            <div key={model.id} className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {model.label}
                  </label>
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      isConfigured
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {isConfigured ? "✓ Configured" : "Missing"}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                {isConfigured && status?.masked && !currentValue && (
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <span>Current key: {status.masked}</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type={isShowing ? "text" : "password"}
                    value={currentValue}
                    onChange={(e) =>
                      setKeyValues((prev) => ({
                        ...prev,
                        [model.id]: e.target.value,
                      }))
                    }
                    placeholder={
                      isConfigured
                        ? "Enter new key to update (leave empty to keep current)"
                        : "Enter API key"
                    }
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                  {currentValue && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setShowKeys((prev) => ({
                            ...prev,
                            [model.id]: !prev[model.id],
                          }))
                        }
                        className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        {isShowing ? "Hide" : "Show"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setKeyValues((prev) => ({
                            ...prev,
                            [model.id]: "",
                          }))
                        }
                        className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 pt-6 border-t border-gray-200">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {saving ? "Saving..." : "Save All Keys"}
        </button>
      </div>
    </div>
  );
}

