{{/* The chart's name, and the release's fullname for its objects. */}}
{{- define "kubestacks.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kubestacks.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains (include "kubestacks.name" .) .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "kubestacks.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "kubestacks.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kubestacks.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "kubestacks.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "kubestacks.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "kubestacks.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "kubestacks.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name must name a service account when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The base path, with a slash at each end. */}}
{{- define "kubestacks.basePath" -}}
{{- $path := trimAll "/" .Values.basePath }}
{{- if $path }}/{{ $path }}/{{ else }}/{{ end }}
{{- end }}

{{/*
Whether the server impersonates people: behind a proxy, and with single sign-on unless
their own tokens are passed on.
*/}}
{{- define "kubestacks.impersonates" -}}
{{- if or (eq .Values.auth.mode "proxy") (and (eq .Values.auth.mode "oidc") (not .Values.auth.oidc.forwardToken)) }}true{{ end }}
{{- end }}
