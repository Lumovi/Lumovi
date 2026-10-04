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
{{- if or .kubeconfigSecret .secrets .agentsSecret }}true{{ end }}
{{- end }}
{{- end }}

{{/*
Whether the server impersonates people: behind a proxy, and with single sign-on unless
their own tokens are passed on.
*/}}
{{- define "lumovi.impersonates" -}}
{{- if or (eq .Values.auth.mode "proxy") (and (eq .Values.auth.mode "oidc") (not .Values.auth.oidc.forwardToken)) }}true{{ end }}
{{- end }}
