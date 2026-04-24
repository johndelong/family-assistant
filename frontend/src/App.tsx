import {
  AppShell,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Container,
  Divider,
  Group,
  Loader,
  NavLink,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconActivityHeartbeat,
  IconApi,
  IconClockHour4,
  IconLogout2,
  IconPackage,
  IconSettings,
  IconWifi,
  IconWifiOff,
  IconUsers
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";

type HealthResponse = {
  status: string;
  service: string;
  environment: string;
  databaseConfigured: boolean;
};

type ExtensionsResponse = {
  extensions: Array<{
    name: string;
    source: string;
    enabled: boolean;
    description?: string;
    package: { version: string; apiVersion: string; tags: string[] };
    structuredExecution?: { runtime: string };
    executionGuardCount: number;
  }>;
  loadErrors: Array<{ directory: string; error: string }>;
};

type CronResponse = {
  jobs: Array<{
    id: string;
    name: string;
    status: string;
    schedule: string;
    timezone: string;
    sessionTarget: string;
    payload: {
      kind: string;
    };
    delivery: {
      type: string;
    };
    nextRunAt: string;
  }>;
};

type HouseholdsResponse = {
  households: Array<{
    id: string;
    name: string;
    createdAt: string;
    peopleCount: number;
  }>;
};

type HouseholdDetailResponse = {
  household: {
    id: string;
    name: string;
    createdAt: string;
  };
  householdProfile?: {
    instructions: string;
    updatedAt: string;
  };
  persons: Array<{
    id: string;
    householdId: string;
    name: string;
    role: string;
    createdAt: string;
    preferences: {
      showProgress: boolean;
      updatedAt: string;
    };
    profile?: {
      instructions: string;
      updatedAt: string;
    };
  }>;
};

type SettingsResponse = {
  runtime: {
    environment: string;
    host: string;
    port: number;
    logLevel: string;
    cronEnabled: boolean;
    cronPollIntervalMs: number;
    frontendOrigins: string[];
    databaseConfigured: boolean;
    openAiConfigured: boolean;
    braveSearchConfigured: boolean;
    telegramConfigured: boolean;
    defaultModel: string;
  };
  assistantIdentity: {
    name: string;
    roleDescription: string;
    introductionPolicy: string;
    signatureName?: string;
    updatedAt: string;
  };
  assistantProfile: {
    instructions: string;
    updatedAt: string;
  };
};

type TracesResponse = {
  traces: Array<{
    requestId: string;
    modifiedAt: string;
  }>;
};

type TraceDetailResponse = {
  requestId: string;
  events: Array<{
    timestamp: string;
    stage: string;
    payload: Record<string, unknown>;
  }>;
};

type MonitorSummaryResponse = {
  traces: Array<{
    requestId: string;
    modifiedAt: string;
  }>;
  cronRuns: Array<{
    id: string;
    jobId: string;
    trigger: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    output?: string;
    error?: string;
  }>;
  structuredExecutionRuns: Array<{
    id: string;
    requestId?: string;
    skillName: string;
    runtime: string;
    status: string;
    messageText: string;
    updatedAt: string;
    completedAt?: string;
  }>;
};

type AdminSessionResponse = {
  ok: true;
  environment: string;
};

type ActiveTab = "overview" | "extensions" | "cron" | "monitor" | "household" | "settings";

export function App() {
  const [runtimeUrl, setRuntimeUrl] = useLocalStorage({
    key: "family-assistant.runtime-url",
    defaultValue: "http://127.0.0.1:3000"
  });
  const [adminToken, setAdminToken] = useLocalStorage({
    key: "family-assistant.admin-token",
    defaultValue: ""
  });
  const [draftRuntimeUrl, setDraftRuntimeUrl] = useState(runtimeUrl);
  const [draftAdminToken, setDraftAdminToken] = useState(adminToken);
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [sessionInfo, setSessionInfo] = useState<AdminSessionResponse | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [extensions, setExtensions] = useState<ExtensionsResponse | null>(null);
  const [cronJobs, setCronJobs] = useState<CronResponse | null>(null);
  const [households, setHouseholds] = useState<HouseholdsResponse | null>(null);
  const [selectedHouseholdId, setSelectedHouseholdId] = useState<string | null>(null);
  const [householdDetail, setHouseholdDetail] = useState<HouseholdDetailResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [traces, setTraces] = useState<TracesResponse | null>(null);
  const [monitorSummary, setMonitorSummary] = useState<MonitorSummaryResponse | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traceDetail, setTraceDetail] = useState<TraceDetailResponse | null>(null);
  const [traceFilter, setTraceFilter] = useState("");
  const [socketStatus, setSocketStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [assistantIdentityDraft, setAssistantIdentityDraft] = useState({
    name: "",
    roleDescription: "",
    signatureName: ""
  });
  const [assistantProfileDraft, setAssistantProfileDraft] = useState("");
  const [householdProfileDraft, setHouseholdProfileDraft] = useState("");

  const api = useMemo(() => createApi(runtimeUrl, adminToken), [runtimeUrl, adminToken]);

  async function run<T>(key: string, fn: () => Promise<T>, onSuccess: (value: T) => void) {
    setLoading((current) => ({ ...current, [key]: true }));
    try {
      const value = await fn();
      onSuccess(value);
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Request failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setLoading((current) => ({ ...current, [key]: false }));
    }
  }

  const refreshOverview = () => {
    void run("health", () => api.get<HealthResponse>("/health", false), setHealth);
    void run("extensions", () => api.get<ExtensionsResponse>("/admin/extensions"), setExtensions);
    void run("cron", () => api.get<CronResponse>("/admin/cron/jobs"), setCronJobs);
  };

  const refreshHouseholds = () => {
    void run("households", () => api.get<HouseholdsResponse>("/admin/households"), (value) => {
      setHouseholds(value);
      setSelectedHouseholdId((current) => current ?? value.households[0]?.id ?? null);
    });
  };

  const refreshSettings = () => {
    void run("settings", () => api.get<SettingsResponse>("/admin/settings"), (value) => {
      setSettings(value);
      setAssistantIdentityDraft({
        name: value.assistantIdentity.name,
        roleDescription: value.assistantIdentity.roleDescription,
        signatureName: value.assistantIdentity.signatureName ?? ""
      });
      setAssistantProfileDraft(value.assistantProfile.instructions);
    });
  };

  const refreshMonitor = () => {
    void run("monitor-summary", () => api.get<MonitorSummaryResponse>("/admin/monitor/summary?limit=20"), (value) => {
      setMonitorSummary(value);
      setTraces({ traces: value.traces });
      setSelectedTraceId((current) => current ?? value.traces[0]?.requestId ?? null);
    });
  };

  const refreshCronJobs = () => {
    void run("cron", () => api.get<CronResponse>("/admin/cron/jobs"), setCronJobs);
  };

  useEffect(() => {
    let cancelled = false;

    async function verifyStoredSession() {
      if (!runtimeUrl.trim() || !adminToken.trim()) {
        if (!cancelled) {
          setAuthStatus("unauthenticated");
          setSessionInfo(null);
        }
        return;
      }

      try {
        const session = await createApi(runtimeUrl, adminToken).get<AdminSessionResponse>("/admin/session");
        if (!cancelled) {
          setSessionInfo(session);
          setAuthStatus("authenticated");
        }
      } catch {
        if (!cancelled) {
          setAuthStatus("unauthenticated");
          setSessionInfo(null);
        }
      }
    }

    void verifyStoredSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      return;
    }

    refreshOverview();
    refreshHouseholds();
    refreshSettings();
    refreshMonitor();
  }, [api, authStatus]);

  useEffect(() => {
    if (!selectedTraceId) {
      setTraceDetail(null);
      return;
    }

    void run("trace-detail", () => api.get<TraceDetailResponse>(`/admin/traces/${selectedTraceId}`), setTraceDetail);
  }, [api, selectedTraceId]);

  useEffect(() => {
    if (!selectedHouseholdId) {
      setHouseholdDetail(null);
      setHouseholdProfileDraft("");
      return;
    }

    void run("household-detail", () => api.get<HouseholdDetailResponse>(`/admin/households/${selectedHouseholdId}`), (value) => {
      setHouseholdDetail(value);
      setHouseholdProfileDraft(value.householdProfile?.instructions ?? "");
    });
  }, [api, selectedHouseholdId]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      return;
    }

    if (activeTab === "overview") {
      refreshOverview();
    }

    if (activeTab === "extensions") {
      void run("extensions", () => api.get<ExtensionsResponse>("/admin/extensions"), setExtensions);
    }

    if (activeTab === "cron") {
      refreshCronJobs();
    }

    if (activeTab === "household") {
      refreshHouseholds();
      if (selectedHouseholdId) {
        void run("household-detail", () => api.get<HouseholdDetailResponse>(`/admin/households/${selectedHouseholdId}`), (value) => {
          setHouseholdDetail(value);
          setHouseholdProfileDraft((current) => current.length > 0 ? current : (value.householdProfile?.instructions ?? ""));
        });
      }
    }

    if (activeTab === "settings") {
      if (!loading["save-identity"] && !loading["save-profile"]) {
        refreshSettings();
      }
    }

    if (activeTab === "monitor") {
      refreshMonitor();
    }
  }, [activeTab, authStatus]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !adminToken.trim() || !runtimeUrl.trim()) {
      setSocketStatus("disconnected");
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimeout: number | undefined;
    let summaryRefreshTimeout: number | undefined;
    let cronRefreshTimeout: number | undefined;
    let errorShown = false;

    const scheduleSummaryRefresh = () => {
      window.clearTimeout(summaryRefreshTimeout);
      summaryRefreshTimeout = window.setTimeout(() => {
        refreshMonitor();
      }, 400);
    };

    const scheduleCronRefresh = () => {
      window.clearTimeout(cronRefreshTimeout);
      cronRefreshTimeout = window.setTimeout(() => {
        refreshCronJobs();
      }, 400);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      setSocketStatus("connecting");
      socket = new WebSocket(buildMonitorWebSocketUrl(runtimeUrl, adminToken));

      socket.onopen = () => {
        errorShown = false;
        setSocketStatus("connected");
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }
        setSocketStatus("disconnected");
        reconnectTimeout = window.setTimeout(connect, 2000);
      };

      socket.onerror = () => {
        if (!disposed) {
          setSocketStatus("disconnected");
        }
      };

      socket.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data as string) as
            | { type: "connected"; timestamp: string }
            | { type: "error"; error: string }
            | { type: "trace.event"; event: TraceDetailResponse["events"][number] & { requestId: string } }
            | { type: "cron.run"; event: MonitorSummaryResponse["cronRuns"][number] }
            | { type: "structured_execution.run"; event: MonitorSummaryResponse["structuredExecutionRuns"][number] };

          if (parsed.type === "error") {
            if (!errorShown) {
              errorShown = true;
              notifications.show({
                color: "red",
                title: "Live connection failed",
                message: parsed.error
              });
            }
            socket?.close();
            return;
          }

          if (parsed.type === "cron.run") {
            setMonitorSummary((current) => {
              if (!current) {
                return current;
              }

              const nextRuns = [...current.cronRuns];
              const existingIndex = nextRuns.findIndex((run) => run.id === parsed.event.id);
              if (existingIndex >= 0) {
                nextRuns.splice(existingIndex, 1);
              }
              nextRuns.unshift(parsed.event);

              return {
                ...current,
                cronRuns: nextRuns.slice(0, 20)
              };
            });
            scheduleCronRefresh();
            return;
          }

          if (parsed.type === "structured_execution.run") {
            setMonitorSummary((current) => {
              if (!current) {
                return current;
              }

              const nextRuns = [...current.structuredExecutionRuns];
              const existingIndex = nextRuns.findIndex((run) => run.id === parsed.event.id);
              if (existingIndex >= 0) {
                nextRuns.splice(existingIndex, 1);
              }
              nextRuns.unshift(parsed.event);

              return {
                ...current,
                structuredExecutionRuns: nextRuns.slice(0, 20)
              };
            });
            return;
          }

          if (parsed.type !== "trace.event") {
            return;
          }

          setTraces((current) => {
            const next = current?.traces ? [...current.traces] : [];
            const existingIndex = next.findIndex((item) => item.requestId === parsed.event.requestId);
            const summary = {
              requestId: parsed.event.requestId,
              modifiedAt: parsed.event.timestamp
            };

            if (existingIndex >= 0) {
              next.splice(existingIndex, 1);
            }

            next.unshift(summary);
            return {
              traces: next.slice(0, 30)
            };
          });

          setSelectedTraceId((current) => current ?? parsed.event.requestId);
          setTraceDetail((current) => {
            if (!current || current.requestId !== parsed.event.requestId) {
              return current;
            }

            return {
              ...current,
              events: [...current.events, parsed.event]
            };
          });

          scheduleSummaryRefresh();
        } catch {
          // Ignore malformed monitor events.
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimeout);
      window.clearTimeout(summaryRefreshTimeout);
      window.clearTimeout(cronRefreshTimeout);
      socket?.close();
    };
  }, [adminToken, authStatus, runtimeUrl]);

  const traceMetrics = useMemo(() => summarizeTraceMetrics(traceDetail), [traceDetail]);
  const filteredTraces = useMemo(() => {
    const items = traces?.traces ?? [];
    const query = traceFilter.trim().toLowerCase();
    if (!query) {
      return items;
    }

    return items.filter((trace) => trace.requestId.toLowerCase().includes(query));
  }, [traces, traceFilter]);

  const saveAssistantIdentity = async () => {
    await run("save-identity", () => api.post<{ assistantIdentity: SettingsResponse["assistantIdentity"] }>("/admin/settings/assistant-identity", {
      ...assistantIdentityDraft
    }), () => {
      notifications.show({ color: "teal", title: "Saved", message: "Assistant identity updated." });
      refreshSettings();
    });
  };

  const saveAssistantProfile = async () => {
    await run("save-profile", () => api.post<{ assistantProfile: SettingsResponse["assistantProfile"] }>("/admin/settings/assistant-profile", {
      instructions: assistantProfileDraft
    }), () => {
      notifications.show({ color: "teal", title: "Saved", message: "Assistant profile updated." });
      refreshSettings();
    });
  };

  const saveHouseholdProfile = async () => {
    if (!selectedHouseholdId) {
      return;
    }

    await run("save-household-profile", () => api.post(`/admin/households/${selectedHouseholdId}/profile`, {
      instructions: householdProfileDraft
    }), () => {
      notifications.show({ color: "teal", title: "Saved", message: "Household profile updated." });
      void run("household-detail", () => api.get<HouseholdDetailResponse>(`/admin/households/${selectedHouseholdId}`), (value) => {
        setHouseholdDetail(value);
        setHouseholdProfileDraft(value.householdProfile?.instructions ?? "");
      });
    });
  };

  const toggleShowProgress = async (personId: string, showProgress: boolean) => {
    await run(`person-pref-${personId}`, () => api.post(`/admin/persons/${personId}/preferences`, {
      showProgress
    }), () => {
      notifications.show({ color: "teal", title: "Updated", message: "Person preference updated." });
      if (selectedHouseholdId) {
        void run("household-detail", () => api.get<HouseholdDetailResponse>(`/admin/households/${selectedHouseholdId}`), setHouseholdDetail);
      }
    });
  };

  const toggleExtension = async (name: string, enabled: boolean) => {
    await run(
      `extension-${name}`,
      () => api.post<{ extension: ExtensionsResponse["extensions"][number] | null }>(
        `/admin/extensions/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`,
        {}
      ),
      () => {
        notifications.show({
          color: "teal",
          title: enabled ? "Extension enabled" : "Extension disabled",
          message: `${name} is now ${enabled ? "enabled" : "disabled"}.`
        });
        void run("extensions", () => api.get<ExtensionsResponse>("/admin/extensions"), setExtensions);
      }
    );
  };

  const updateCronJobStatus = async (jobId: string, status: "active" | "paused") => {
    await run(
      `cron-${jobId}-${status}`,
      () => api.post(`/admin/cron/jobs/${jobId}/${status === "active" ? "resume" : "pause"}`, {}),
      () => {
        notifications.show({
          color: "teal",
          title: status === "active" ? "Cron resumed" : "Cron paused",
          message: `Job is now ${status}.`
        });
        refreshCronJobs();
      }
    );
  };

  const deleteCronJob = async (jobId: string) => {
    await run(
      `cron-delete-${jobId}`,
      () => api.delete(`/admin/cron/jobs/${jobId}`),
      () => {
        notifications.show({
          color: "teal",
          title: "Cron deleted",
          message: "Cron job removed."
        });
        refreshCronJobs();
      }
    );
  };

  async function handleLogin() {
    setLoading((current) => ({ ...current, login: true }));
    try {
      const session = await createApi(draftRuntimeUrl, draftAdminToken).get<AdminSessionResponse>("/admin/session");
      setRuntimeUrl(draftRuntimeUrl.trim());
      setAdminToken(draftAdminToken.trim());
      setSessionInfo(session);
      setAuthStatus("authenticated");
      notifications.show({
        color: "teal",
        title: "Connected",
        message: "Admin session established."
      });
    } catch (error) {
      setSessionInfo(null);
      setAuthStatus("unauthenticated");
      notifications.show({
        color: "red",
        title: "Login failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setLoading((current) => ({ ...current, login: false }));
    }
  }

  function handleLogout() {
    setAdminToken("");
    setDraftAdminToken("");
    setAuthStatus("unauthenticated");
    setSessionInfo(null);
    setSocketStatus("disconnected");
  }

  if (authStatus !== "authenticated") {
    return (
      <Container size="sm" py={80}>
        <Card radius="xl" withBorder>
          <Stack gap="lg">
            <Box>
              <Text c="teal.7" fw={700} tt="uppercase" size="xs">Family Assistant</Text>
              <Title order={1} mt={4}>Admin Login</Title>
              <Text c="dimmed" mt={8}>
                Enter a runtime URL and valid admin token before loading the operator dashboard.
              </Text>
            </Box>
            <TextInput
              label="Runtime URL"
              value={draftRuntimeUrl}
              onChange={(event) => setDraftRuntimeUrl(event.currentTarget.value)}
            />
            <TextInput
              label="Admin Token"
              type="password"
              value={draftAdminToken}
              onChange={(event) => setDraftAdminToken(event.currentTarget.value)}
            />
            <Button onClick={() => void handleLogin()} loading={loading.login}>
              {authStatus === "checking" ? "Checking..." : "Login"}
            </Button>
          </Stack>
        </Card>
      </Container>
    );
  }

  return (
    <AppShell padding="md" navbar={{ width: 290, breakpoint: "sm" }}>
      <AppShell.Navbar p="md">
        <Stack justify="space-between" h="100%">
          <Stack gap="xs">
            <Box>
              <Text c="teal.7" fw={700} tt="uppercase" size="xs">Family Assistant</Text>
              <Title order={2} lh={1}>Operator UI</Title>
              <Text c="dimmed" mt={6} size="sm">Frontend only. Runtime logic lives in the backend.</Text>
            </Box>
            <Divider my="sm" />
            <NavLink label="Overview" leftSection={<IconApi size={16} />} active={activeTab === "overview"} onClick={() => setActiveTab("overview")} />
            <NavLink label="Extensions" leftSection={<IconPackage size={16} />} active={activeTab === "extensions"} onClick={() => setActiveTab("extensions")} />
            <NavLink label="Cron Jobs" leftSection={<IconClockHour4 size={16} />} active={activeTab === "cron"} onClick={() => setActiveTab("cron")} />
            <NavLink label="Monitor" leftSection={<IconActivityHeartbeat size={16} />} active={activeTab === "monitor"} onClick={() => setActiveTab("monitor")} />
            <NavLink label="Household" leftSection={<IconUsers size={16} />} active={activeTab === "household"} onClick={() => setActiveTab("household")} />
            <NavLink label="Settings" leftSection={<IconSettings size={16} />} active={activeTab === "settings"} onClick={() => setActiveTab("settings")} />
          </Stack>

          <Card radius="xl" withBorder className="sessionCard">
            <Stack gap="sm">
              <Text fw={600}>Session</Text>
              <Group gap="xs">
                {socketStatus === "connected" ? <IconWifi size={16} className="sessionIcon sessionIconLive" /> : <IconWifiOff size={16} className="sessionIcon sessionIconIdle" />}
                <Text size="sm" fw={500}>
                  {socketStatus === "connected" ? "Websocket live" : socketStatus === "connecting" ? "Websocket connecting" : "Websocket idle"}
                </Text>
              </Group>
              <Text size="sm" c="dimmed">
                {sessionInfo?.environment ?? "connected"}
              </Text>
              <Text size="sm" c="dimmed">
                Connected to {runtimeUrl}
              </Text>
              <Button variant="subtle" color="gray" leftSection={<IconLogout2 size={16} />} onClick={handleLogout}>
                Logout
              </Button>
            </Stack>
          </Card>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Container size="xl">
          {activeTab === "overview" && (
            <Stack gap="lg">
              <PageHeader title="Overview" subtitle="Quick operator signal across runtime health, extension load state, automation volume, and household state." />
              <SimpleGrid cols={{ base: 1, md: 4 }}>
                <MetricCard label="Runtime" value={health?.status ?? "Unknown"} note={health ? `${health.service} • ${health.environment}` : "Waiting for runtime response"} loading={loading.health} />
                <MetricCard label="Extensions" value={String(extensions?.extensions.length ?? 0)} note={extensions?.loadErrors.length ? `${extensions.loadErrors.length} load errors` : "Registry-backed packages"} loading={loading.extensions} />
                <MetricCard label="Cron Jobs" value={String(cronJobs?.jobs.length ?? 0)} note={cronJobs ? `${cronJobs.jobs.filter((job) => job.status === "active").length} active` : "No automation data yet"} loading={loading.cron} />
                <MetricCard label="Households" value={String(households?.households.length ?? 0)} note={households ? `${households.households.reduce((sum, household) => sum + household.peopleCount, 0)} people tracked` : "No household data yet"} loading={loading.households} />
              </SimpleGrid>
            </Stack>
          )}

          {activeTab === "extensions" && (
            <Stack gap="lg">
              <PageHeader title="Extensions" subtitle="Installable packages and their runtime capabilities." />
              <Stack gap="md">
                {extensions?.extensions.map((extension) => (
                  <Card key={extension.name} radius="xl" withBorder>
                    <Group justify="space-between" align="start">
                      <div>
                        <Group gap="xs">
                          <Text fw={700}>{extension.name}</Text>
                          <Badge variant="light">{extension.package.version}</Badge>
                          <Badge color="gray" variant="dot">{extension.source}</Badge>
                          <Badge color={extension.enabled ? "teal" : "gray"} variant="light">
                            {extension.enabled ? "enabled" : "disabled"}
                          </Badge>
                        </Group>
                        <Text c="dimmed" size="sm" mt={6}>{extension.description ?? "No description yet."}</Text>
                      </div>
                      <Stack gap={4} align="end">
                        <Code>api {extension.package.apiVersion}</Code>
                        <Text size="sm" c="dimmed">{extension.structuredExecution ? `workflow: ${extension.structuredExecution.runtime}` : "no structured execution"}</Text>
                        <Switch
                          size="sm"
                          checked={extension.enabled}
                          onChange={(event) => void toggleExtension(extension.name, event.currentTarget.checked)}
                          label={extension.enabled ? "Enabled" : "Disabled"}
                        />
                      </Stack>
                    </Group>
                  </Card>
                ))}
                {extensions?.loadErrors.length ? (
                  <Card radius="xl" withBorder>
                    <Text fw={700} mb="sm">Load errors</Text>
                    <Stack gap="xs">
                      {extensions.loadErrors.map((error) => (
                        <Paper key={`${error.directory}-${error.error}`} p="sm" radius="md" bg="red.0">
                          <Text size="sm" fw={600}>{error.directory}</Text>
                          <Text size="sm">{error.error}</Text>
                        </Paper>
                      ))}
                    </Stack>
                  </Card>
                ) : null}
              </Stack>
            </Stack>
          )}

          {activeTab === "cron" && (
            <Stack gap="lg">
              <PageHeader title="Cron Jobs" subtitle="Scheduled automations driven by prompts or workflow extensions." />
              <Stack gap="md">
                {cronJobs?.jobs.map((job) => (
                  <Card key={job.id} radius="xl" withBorder>
                    <Group justify="space-between" align="start">
                      <div>
                        <Group gap="xs">
                          <Text fw={700}>{job.name}</Text>
                          <Badge color={job.status === "active" ? "teal" : "gray"} variant="light">{job.status}</Badge>
                        </Group>
                        <Text size="sm" c="dimmed" mt={6}>{job.schedule} • {job.timezone} • {job.sessionTarget} • payload: {job.payload.kind} • delivery: {job.delivery.type}</Text>
                      </div>
                      <Stack gap={6} align="end">
                        <Code>{new Date(job.nextRunAt).toLocaleString()}</Code>
                        <Group gap="xs">
                          <Button
                            size="xs"
                            variant="light"
                            onClick={() => void updateCronJobStatus(job.id, job.status === "active" ? "paused" : "active")}
                          >
                            {job.status === "active" ? "Pause" : "Resume"}
                          </Button>
                          <Button
                            size="xs"
                            variant="light"
                            color="red"
                            onClick={() => void deleteCronJob(job.id)}
                          >
                            Delete
                          </Button>
                        </Group>
                      </Stack>
                    </Group>
                  </Card>
                ))}
              </Stack>
            </Stack>
          )}

          {activeTab === "monitor" && (
            <Stack gap="lg">
              <PageHeader title="Monitor" subtitle="Recent trace activity, cron runs, and workflow runs for watching the system work in near real time." />
              <Group>
                <TextInput
                  placeholder="Filter traces by request ID"
                  value={traceFilter}
                  onChange={(event) => setTraceFilter(event.currentTarget.value)}
                />
              </Group>
              <SimpleGrid cols={{ base: 1, md: 3 }}>
                <MetricCard label="Events" value={String(traceMetrics.eventCount)} note="Trace events in selected request" loading={loading["trace-detail"]} />
                <MetricCard label="Tools Used" value={String(traceMetrics.usedTools)} note="Tool calls recorded by the selected trace" loading={loading["trace-detail"]} />
                <MetricCard label="Route" value={traceMetrics.route} note="Completion route for the selected request" loading={loading["trace-detail"]} />
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, xl: 3 }}>
                <Card radius="xl" withBorder>
                  <Stack gap="sm">
                    <Text fw={700}>Recent Requests</Text>
                    <ScrollArea h={480}>
                      <Stack gap="xs">
                        {filteredTraces.map((trace) => (
                          <Paper
                            key={trace.requestId}
                            p="sm"
                            radius="md"
                            className={selectedTraceId === trace.requestId ? "traceItem traceItemActive" : "traceItem"}
                            onClick={() => setSelectedTraceId(trace.requestId)}
                          >
                            <Text fw={600} size="sm">{trace.requestId}</Text>
                            <Text size="xs" c="dimmed">{new Date(trace.modifiedAt).toLocaleString()}</Text>
                          </Paper>
                        ))}
                      </Stack>
                    </ScrollArea>
                  </Stack>
                </Card>
                <Card radius="xl" withBorder>
                  <Stack gap="sm">
                    <Text fw={700}>Recent Cron Runs</Text>
                    <ScrollArea h={480}>
                      <Stack gap="xs">
                        {monitorSummary?.cronRuns.map((run) => (
                          <Paper key={run.id} p="sm" radius="md" withBorder>
                            <Group justify="space-between">
                              <Text fw={600} size="sm">{run.status}</Text>
                              <Badge variant="light">{run.trigger}</Badge>
                            </Group>
                            <Text size="xs" c="dimmed">{new Date(run.startedAt).toLocaleString()}</Text>
                            <Text size="xs" mt={4}>job {run.jobId}</Text>
                          </Paper>
                        ))}
                      </Stack>
                    </ScrollArea>
                  </Stack>
                </Card>
                <Card radius="xl" withBorder>
                  <Stack gap="sm">
                    <Text fw={700}>Structured Runs</Text>
                    <ScrollArea h={480}>
                      <Stack gap="xs">
                        {monitorSummary?.structuredExecutionRuns.map((run) => (
                          <Paper key={run.id} p="sm" radius="md" withBorder>
                            <Group justify="space-between">
                              <Text fw={600} size="sm">{run.skillName}</Text>
                              <Badge variant="light">{run.status}</Badge>
                            </Group>
                            <Text size="xs" c="dimmed">{new Date(run.updatedAt).toLocaleString()}</Text>
                            <Text size="xs" mt={4}>{run.messageText}</Text>
                          </Paper>
                        ))}
                      </Stack>
                    </ScrollArea>
                  </Stack>
                </Card>
              </SimpleGrid>
              <Card radius="xl" withBorder>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Text fw={700}>Trace Detail</Text>
                    {loading["trace-detail"] ? <Loader size="sm" /> : null}
                  </Group>
                  <ScrollArea h={520}>
                    <Stack gap="sm">
                      {traceDetail?.events.map((event) => (
                        <Paper key={`${event.timestamp}-${event.stage}`} p="sm" radius="md" withBorder>
                          <Group justify="space-between" align="start">
                            <div>
                              <Text fw={700} size="sm">{event.stage}</Text>
                              <Text size="xs" c="dimmed">{new Date(event.timestamp).toLocaleString()}</Text>
                            </div>
                          </Group>
                          <pre className="tracePre">{JSON.stringify(event.payload, null, 2)}</pre>
                        </Paper>
                      )) ?? "Select a trace to inspect."}
                    </Stack>
                  </ScrollArea>
                </Stack>
              </Card>
            </Stack>
          )}

          {activeTab === "household" && (
            <Stack gap="lg">
              <PageHeader title="Household" subtitle="Family structure, per-person runtime preferences, and household-level instruction context." />
              <SimpleGrid cols={{ base: 1, xl: 2 }}>
                <Card radius="xl" withBorder>
                  <Stack gap="sm">
                    <Group justify="space-between">
                      <Text fw={700}>Households</Text>
                    </Group>
                    <Stack gap="xs">
                      {households?.households.map((household) => (
                        <Paper
                          key={household.id}
                          p="sm"
                          radius="md"
                          className={selectedHouseholdId === household.id ? "traceItem traceItemActive" : "traceItem"}
                          onClick={() => setSelectedHouseholdId(household.id)}
                        >
                          <Group justify="space-between" align="start">
                            <div>
                              <Text fw={700} size="sm">{household.name}</Text>
                              <Text size="xs" c="dimmed">{new Date(household.createdAt).toLocaleDateString()}</Text>
                            </div>
                            <Badge variant="light">{household.peopleCount} people</Badge>
                          </Group>
                        </Paper>
                      ))}
                    </Stack>
                  </Stack>
                </Card>
                <Card radius="xl" withBorder>
                  <Stack gap="sm">
                    <Text fw={700}>Details</Text>
                    {loading["household-detail"] ? <Loader size="sm" /> : null}
                    {householdDetail ? (
                      <>
                        <Group justify="space-between" align="start">
                          <div>
                            <Title order={3}>{householdDetail.household.name}</Title>
                            <Text c="dimmed" size="sm">Created {new Date(householdDetail.household.createdAt).toLocaleDateString()}</Text>
                          </div>
                          <Badge variant="light">{householdDetail.persons.length} people</Badge>
                        </Group>
                        <Card radius="lg" withBorder>
                          <Stack gap="sm">
                            <Text fw={600}>Household Profile</Text>
                            <Textarea
                              minRows={5}
                              value={householdProfileDraft}
                              onChange={(event) => setHouseholdProfileDraft(event.currentTarget.value)}
                            />
                            <Group justify="space-between">
                              <Text size="xs" c="dimmed">
                                {householdDetail.householdProfile?.updatedAt
                                  ? `Updated ${new Date(householdDetail.householdProfile.updatedAt).toLocaleString()}`
                                  : "No household profile set yet"}
                              </Text>
                              <Button size="xs" onClick={saveHouseholdProfile} loading={loading["save-household-profile"]}>
                                Save Profile
                              </Button>
                            </Group>
                          </Stack>
                        </Card>
                        <Table striped highlightOnHover>
                          <Table.Thead>
                            <Table.Tr>
                              <Table.Th>Name</Table.Th>
                              <Table.Th>Role</Table.Th>
                              <Table.Th>Progress</Table.Th>
                              <Table.Th>Profile</Table.Th>
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {householdDetail.persons.map((person) => (
                              <Table.Tr key={person.id}>
                                <Table.Td>{person.name}</Table.Td>
                                <Table.Td>{person.role}</Table.Td>
                                <Table.Td>
                                  <Switch
                                    checked={person.preferences.showProgress}
                                    onChange={(event) => void toggleShowProgress(person.id, event.currentTarget.checked)}
                                  />
                                </Table.Td>
                                <Table.Td>{person.profile ? "Custom" : "Default"}</Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      </>
                    ) : (
                      <Text c="dimmed">Select a household to inspect.</Text>
                    )}
                  </Stack>
                </Card>
              </SimpleGrid>
            </Stack>
          )}

          {activeTab === "settings" && (
            <Stack gap="lg">
              <PageHeader title="Settings" subtitle="Current runtime configuration and editable assistant persona state exposed by the backend." />
              {settings ? (
                <SimpleGrid cols={{ base: 1, xl: 2 }}>
                  <Card radius="xl" withBorder>
                    <Text fw={700} mb="sm">Runtime</Text>
                    <Stack gap="xs">
                      <SettingRow label="Environment" value={settings.runtime.environment} />
                      <SettingRow label="Bind" value={`${settings.runtime.host}:${settings.runtime.port}`} />
                      <SettingRow label="Log Level" value={settings.runtime.logLevel} />
                      <SettingRow label="Default Model" value={settings.runtime.defaultModel} />
                      <SettingRow label="Cron" value={settings.runtime.cronEnabled ? `Enabled • ${settings.runtime.cronPollIntervalMs}ms` : "Disabled"} />
                      <SettingRow label="Database" value={settings.runtime.databaseConfigured ? "Configured" : "Missing"} />
                      <SettingRow label="OpenAI" value={settings.runtime.openAiConfigured ? "Configured" : "Missing"} />
                      <SettingRow label="Brave Search" value={settings.runtime.braveSearchConfigured ? "Configured" : "Missing"} />
                      <SettingRow label="Telegram" value={settings.runtime.telegramConfigured ? "Configured" : "Missing"} />
                    </Stack>
                  </Card>
                  <Card radius="xl" withBorder>
                    <Stack gap="sm">
                      <Text fw={700}>Assistant Identity</Text>
                      <TextInput label="Name" value={assistantIdentityDraft.name} onChange={(event) => setAssistantIdentityDraft((current) => ({ ...current, name: event.currentTarget.value }))} />
                      <TextInput label="Signature Name" value={assistantIdentityDraft.signatureName} onChange={(event) => setAssistantIdentityDraft((current) => ({ ...current, signatureName: event.currentTarget.value }))} />
                      <Textarea label="Role Description" minRows={4} value={assistantIdentityDraft.roleDescription} onChange={(event) => setAssistantIdentityDraft((current) => ({ ...current, roleDescription: event.currentTarget.value }))} />
                      <Group justify="space-between">
                        <Text size="xs" c="dimmed">Intro policy: {settings.assistantIdentity.introductionPolicy}</Text>
                        <Button size="xs" onClick={() => void saveAssistantIdentity()} loading={loading["save-identity"]}>Save Identity</Button>
                      </Group>
                      <Divider my="xs" />
                      <Text fw={700}>Assistant Profile</Text>
                      <Textarea minRows={8} value={assistantProfileDraft} onChange={(event) => setAssistantProfileDraft(event.currentTarget.value)} />
                      <Group justify="space-between">
                        <Text size="xs" c="dimmed">Updated {new Date(settings.assistantProfile.updatedAt).toLocaleString()}</Text>
                        <Button size="xs" onClick={() => void saveAssistantProfile()} loading={loading["save-profile"]}>Save Profile</Button>
                      </Group>
                    </Stack>
                  </Card>
                </SimpleGrid>
              ) : null}
            </Stack>
          )}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}

function MetricCard(props: { label: string; value: string; note: string; loading?: boolean }) {
  return (
    <Card radius="xl" withBorder>
      <Stack gap="xs">
        <Text c="dimmed" size="sm">{props.label}</Text>
        <Group gap="sm" align="end">
          <Title order={2}>{props.value}</Title>
          {props.loading ? <Loader size="sm" /> : null}
        </Group>
        <Text size="sm">{props.note}</Text>
      </Stack>
    </Card>
  );
}

function PageHeader(props: { title: string; subtitle: string }) {
  return (
    <Box>
      <Text c="teal.7" fw={700} tt="uppercase" size="xs">Operator Surface</Text>
      <Title order={1} mt={4}>{props.title}</Title>
      <Text c="dimmed" mt={8}>{props.subtitle}</Text>
    </Box>
  );
}

function SettingRow(props: { label: string; value: string }) {
  return (
    <Group justify="space-between" align="start">
      <Text c="dimmed" size="sm">{props.label}</Text>
      <Code>{props.value}</Code>
    </Group>
  );
}

function summarizeTraceMetrics(traceDetail: TraceDetailResponse | null) {
  if (!traceDetail) {
    return {
      eventCount: 0,
      usedTools: 0,
      route: "Unknown"
    };
  }

  const llmEvent = traceDetail.events.find((event) => event.stage === "llm.invoked");
  const completedEvent = [...traceDetail.events].reverse().find((event) => event.stage === "request.completed");
  const usedTools = Array.isArray(llmEvent?.payload.usedTools) ? llmEvent.payload.usedTools.length : 0;
  const routeValue = completedEvent?.payload.route;

  return {
    eventCount: traceDetail.events.length,
    usedTools,
    route: typeof routeValue === "string" ? routeValue : "Unknown"
  };
}

function createApi(runtimeUrl: string, adminToken: string) {
  return {
    async get<T>(path: string, auth = true): Promise<T> {
      const headers = auth ? { authorization: `Bearer ${adminToken}` } : undefined;
      const response = await fetch(new URL(path, runtimeUrl), { headers });
      const text = await response.text();
      const payload = text.length > 0 ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `Request failed with status ${response.status}`);
      }

      return payload as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const response = await fetch(new URL(path, runtimeUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      const payload = text.length > 0 ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `Request failed with status ${response.status}`);
      }

      return payload as T;
    },
    async delete<T>(path: string): Promise<T> {
      const response = await fetch(new URL(path, runtimeUrl), {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${adminToken}`
        }
      });
      const text = await response.text();
      const payload = text.length > 0 ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `Request failed with status ${response.status}`);
      }

      return payload as T;
    }
  };
}

function buildMonitorWebSocketUrl(runtimeUrl: string, adminToken: string) {
  const url = new URL("/admin/monitor/ws", runtimeUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", adminToken);
  return url.toString();
}
