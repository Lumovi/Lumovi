{{/* The chart's name, and the release's fullname for its objects. */}}
{{- define "lumovi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "lumovi.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains (include "lumovi.name" .) .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "lumovi.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "lumovi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lumovi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "lumovi.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "lumovi.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "lumovi.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "lumovi.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name must name a service account when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Labels as LUMOVI_CLUSTER_LABELS takes them: env=production,region=eu */}}
{{- define "lumovi.labelList" -}}
{{- $pairs := list }}
{{- range $key, $value := . }}{{ $pairs = append $pairs (printf "%s=%s" $key $value) }}{{ end }}
{{- join "," $pairs }}
{{- end }}

{{/* The base path, with a slash at each end. */}}
{{- define "lumovi.basePath" -}}
{{- $path := trimAll "/" .Values.basePath }}
{{- if $path }}/{{ $path }}/{{ else }}/{{ end }}
{{- end }}

{{/* Whether this release is Lumovi itself (rather than a fleet's member or agent). */}}
{{- define "lumovi.dashboard" -}}
{{- if eq .Values.mode "dashboard" }}true{{ end }}
{{- end }}

{{/* Whether the dashboard shows a fleet: clusters from a kubeconfig, Secrets or agents. */}}
{{- define "lumovi.fleet" -}}
{{- with .Values.fleet }}
{{- if or .kubeconfigSecret .secrets .agentsSecret .addFromPage }}true{{ end }}
{{- end }}
{{- end }}

{{/*
Whether the server impersonates people: behind a proxy, and with single sign-on unless
their own tokens are passed on.
*/}}
{{- define "lumovi.impersonates" -}}
{{- if or (eq .Values.auth.mode "proxy") (and (eq .Values.auth.mode "oidc") (not .Values.auth.oidc.forwardToken)) }}true{{ end }}
{{- end }}

{{/* What AI assistants' changes do: the default, then each cluster's own (ask,staging=allow). */}}
{{- define "lumovi.assistantChanges" -}}
{{- $entries := list }}
{{- with .Values.assistants.changes }}
{{- $entries = append $entries . }}
{{- end }}
{{- range $cluster, $changes := .Values.assistants.clusters }}
{{- $entries = append $entries (printf "%s=%s" $cluster $changes) }}
{{- end }}
{{- join "," $entries }}
{{- end }}

{{/* The proxy Lumovi's own connections go through, and certificate authorities it trusts. */}}
{{- define "lumovi.networkEnv" -}}
{{- if and .Values.proxy.secret (or .Values.proxy.https .Values.proxy.http) }}
{{- fail "proxy.secret holds the proxies' URLs: give it, or proxy.https and proxy.http, not both." }}
{{- end }}
{{- with .Values.proxy.secret }}
{{- /* HTTPS_PROXY must be there: a Secret misnamed, or without it, stops the pod, saying so. */}}
- name: HTTPS_PROXY
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: HTTPS_PROXY
- name: HTTP_PROXY
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: HTTP_PROXY
      optional: true
{{- end }}
{{- with .Values.proxy.https }}
- name: HTTPS_PROXY
  value: {{ . | quote }}
{{- end }}
{{- with .Values.proxy.http }}
- name: HTTP_PROXY
  value: {{ . | quote }}
{{- end }}
{{- with .Values.proxy.noProxy }}
- name: NO_PROXY
  value: {{ . | quote }}
{{- end }}
{{- if or .Values.extraCA.configMap .Values.extraCA.secret }}
- name: LUMOVI_CA_FILE
  value: /etc/lumovi/ca/{{ .Values.extraCA.key }}
{{- end }}
{{- end }}

{{- define "lumovi.caMount" -}}
{{- if or .Values.extraCA.configMap .Values.extraCA.secret }}
- name: ca
  mountPath: /etc/lumovi/ca
  readOnly: true
{{- end }}
{{- end }}

{{- define "lumovi.caVolume" -}}
{{- if .Values.extraCA.configMap }}
- name: ca
  configMap:
    name: {{ .Values.extraCA.configMap }}
{{- else if .Values.extraCA.secret }}
- name: ca
  secret:
    secretName: {{ .Values.extraCA.secret }}
{{- end }}
{{- end }}

{{/*
Whether it's installed on OpenShift: where its security context constraints give each pod's
user, group and fsGroup from the namespace's ranges (auto: where the cluster has them).
*/}}
{{- define "lumovi.openshift" -}}
{{- if eq (toString .Values.openshift) "true" }}true
{{- else if and (eq (toString .Values.openshift) "auto") (.Capabilities.APIVersions.Has "security.openshift.io/v1") }}true
{{- end }}
{{- end }}

{{/* The pod's security context: on OpenShift, without the user and groups its SCC gives. */}}
{{- define "lumovi.podSecurityContext" -}}
{{- if include "lumovi.openshift" . }}
{{- toYaml (omit .Values.podSecurityContext "runAsUser" "runAsGroup" "fsGroup") }}
{{- else }}
{{- toYaml .Values.podSecurityContext }}
{{- end }}
{{- end }}

{{/* Where a fleet keeps the clusters added on its page: a namespace of their own. */}}
{{- define "lumovi.addNamespace" -}}
{{- .Values.fleet.addNamespace | default (printf "%s-clusters" .Release.Namespace) }}
{{- end }}
