{{- define "keel.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "keel.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "keel.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "keel.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "keel.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secret" (include "keel.fullname" .)) -}}
{{- end -}}

{{- define "keel.databaseUrl" -}}
{{- if .Values.postgres.enabled -}}
postgresql+psycopg://keel:{{ required "postgres.password is required when postgres.enabled" .Values.postgres.password }}@{{ include "keel.fullname" . }}-postgres:5432/keel
{{- else -}}
{{ .Values.database.url }}
{{- end -}}
{{- end -}}

{{/* Shared pod bits: env, security, volumes for a writable /tmp under a read-only root. */}}
{{- define "keel.podEnv" -}}
envFrom:
  - configMapRef:
      name: {{ include "keel.fullname" . }}-config
  - secretRef:
      name: {{ include "keel.secretName" . }}
securityContext:
  {{- toYaml .Values.securityContext | nindent 2 }}
volumeMounts:
  - {name: tmp, mountPath: /tmp}
  - {name: home, mountPath: /home/keel}
{{- end -}}

{{- define "keel.podVolumes" -}}
volumes:
  - {name: tmp, emptyDir: {}}
  - {name: home, emptyDir: {}}
{{- end -}}
