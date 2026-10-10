/**
 * What `create-form-written.spec.ts` expects of each text at each stage: recorded by the spec
 * itself (LUMOVI_RECORD=1), then read by a person, line by line, before being kept. What to
 * know when reading one:
 * - a value the form replaces is written the plain way, in quotes only where it needs them,
 *   so the quotes its author gave that one value go (`"ghcr.io/…"` in the first text, every
 *   replaced value in the JSON one, which stays YAML that means the same and not JSON);
 * - a map or a list in brackets that takes or loses something is written again as its own
 *   characters, with the `yaml` package's spacing (`[ { … } ]`);
 * - what's written new is indented by two, whatever the text around it is indented by.
 */
export const EXPECTED: Record<string, string> = {
  'with comments, in its own order: pasted': `# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: web
  annotations:
    team: storefront
spec:
  replicas: 2 # two for now
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      nodeSelector:
        pool: general
      containers:
        - name: web
          image: "ghcr.io/acme/web:2.4.1"   # pinned
          ports:
            - containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: info
`,
  'with comments, in its own order: values changed': `# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: storefront
  annotations:
    team: storefront
spec:
  replicas: 3 # two for now
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      nodeSelector:
        pool: general
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0   # pinned
          ports:
            - containerPort: 9090
          env:
            - name: LOG_LEVEL
              value: info
`,
  'with comments, in its own order: added to': `# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: storefront
  annotations:
    team: storefront
spec:
  replicas: 3 # two for now
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      nodeSelector:
        pool: general
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0   # pinned
          ports:
            - containerPort: 9090
          env:
            - name: LOG_LEVEL
              value: info
            - name: FEATURE_FLAGS
              value: "on"
            - name: GREETING
              value: "hello: world # not a comment"
          resources:
            requests:
              cpu: 250m
            limits:
              memory: 256Mi
`,
  'with comments, in its own order: taken away': `# The shop's front end.
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: shop   # where it lives
  name: storefront
  annotations:
    team: storefront
spec:
  replicas: 3 # two for now
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      nodeSelector:
        pool: general
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0   # pinned
          env:
            - name: LOG_LEVEL
              value: info
`,
  'as flow maps: pasted': `apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: shop }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - { name: web, image: nginx:1.27, ports: [{ containerPort: 80 }] }
`,
  'as flow maps: values changed': `apiVersion: apps/v1
kind: Deployment
metadata: { name: storefront, namespace: shop }
spec:
  replicas: 3
  selector: { matchLabels: { app: storefront } }
  template:
    metadata: { labels: { app: storefront } }
    spec:
      containers:
        - { name: storefront, image: ghcr.io/acme/storefront:3.0.0, ports: [{ containerPort: 9090 }] }
`,
  'as flow maps: added to': `apiVersion: apps/v1
kind: Deployment
metadata: { name: storefront, namespace: shop }
spec:
  replicas: 3
  selector: { matchLabels: { app: storefront } }
  template:
    metadata: { labels: { app: storefront } }
    spec:
      containers:
        - { name: storefront, image: ghcr.io/acme/storefront:3.0.0, ports: [ { containerPort: 9090 } ], env: [ { name: FEATURE_FLAGS, value: "on" }, { name: GREETING, value: "hello: world # not a comment" } ], resources: { requests: { cpu: 250m }, limits: { memory: 256Mi } } }
`,
  'as flow maps: taken away': `apiVersion: apps/v1
kind: Deployment
metadata: { name: storefront, namespace: shop }
spec:
  replicas: 3
  selector: { matchLabels: { app: storefront } }
  template:
    metadata: { labels: { app: storefront } }
    spec:
      containers:
        - { name: storefront, image: ghcr.io/acme/storefront:3.0.0 }
`,
  'indented by four, its lists not indented: pasted': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: web
    namespace: shop
spec:
    replicas: 2
    selector:
        matchLabels:
            app: web
    template:
        metadata:
            labels:
                app: web
        spec:
            containers:
            - name: web
              image: nginx:1.27
              ports:
              - containerPort: 80
              env:
              - name: LOG_LEVEL
                value: info
`,
  'indented by four, its lists not indented: values changed': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: storefront
    namespace: shop
spec:
    replicas: 3
    selector:
        matchLabels:
            app: storefront
    template:
        metadata:
            labels:
                app: storefront
        spec:
            containers:
            - name: storefront
              image: ghcr.io/acme/storefront:3.0.0
              ports:
              - containerPort: 9090
              env:
              - name: LOG_LEVEL
                value: info
`,
  'indented by four, its lists not indented: added to': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: storefront
    namespace: shop
spec:
    replicas: 3
    selector:
        matchLabels:
            app: storefront
    template:
        metadata:
            labels:
                app: storefront
        spec:
            containers:
            - name: storefront
              image: ghcr.io/acme/storefront:3.0.0
              ports:
              - containerPort: 9090
              env:
              - name: LOG_LEVEL
                value: info
              - name: FEATURE_FLAGS
                value: "on"
              - name: GREETING
                value: "hello: world # not a comment"
              resources:
                requests:
                  cpu: 250m
                limits:
                  memory: 256Mi
`,
  'indented by four, its lists not indented: taken away': `apiVersion: apps/v1
kind: Deployment
metadata:
    name: storefront
    namespace: shop
spec:
    replicas: 3
    selector:
        matchLabels:
            app: storefront
    template:
        metadata:
            labels:
                app: storefront
        spec:
            containers:
            - name: storefront
              image: ghcr.io/acme/storefront:3.0.0
              env:
              - name: LOG_LEVEL
                value: info
`,
  'half filled in, with a note of several lines: pasted': `apiVersion: apps/v1
kind: Deployment
metadata:
  name:
  namespace: 'shop'
  annotations:
    note: |
      Ask the storefront team
      before changing this.
spec:
  replicas: 1
  selector:
    matchLabels:
      app:
  template:
    metadata:
      labels:
        app:
    spec:
      containers:
        - name:
          image:
          env: []
          resources: {}
`,
  'half filled in, with a note of several lines: values changed': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: 'shop'
  annotations:
    note: |
      Ask the storefront team
      before changing this.
spec:
  replicas: 3
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0
          ports:
            - containerPort: 9090
          env: []
          resources: {}
`,
  'half filled in, with a note of several lines: added to': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: 'shop'
  annotations:
    note: |
      Ask the storefront team
      before changing this.
spec:
  replicas: 3
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0
          ports:
            - containerPort: 9090
          env:
            - name: FEATURE_FLAGS
              value: "on"
            - name: GREETING
              value: "hello: world # not a comment"
          resources:
            requests:
              cpu: 250m
            limits:
              memory: 256Mi
`,
  'half filled in, with a note of several lines: taken away': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: 'shop'
  annotations:
    note: |
      Ask the storefront team
      before changing this.
spec:
  replicas: 3
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0
`,
  'as JSON: pasted': `{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": "web", "namespace": "shop" },
  "spec": {
    "replicas": 2,
    "selector": { "matchLabels": { "app": "web" } },
    "template": {
      "metadata": { "labels": { "app": "web" } },
      "spec": { "containers": [{ "name": "web", "image": "nginx:1.27" }] }
    }
  }
}
`,
  'as JSON: values changed': `{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": storefront, "namespace": "shop" },
  "spec": {
    "replicas": 3,
    "selector": { "matchLabels": { "app": storefront } },
    "template": {
      "metadata": { "labels": { "app": storefront } },
      "spec": { "containers": [{ "name": storefront, "image": ghcr.io/acme/storefront:3.0.0, ports: [ { containerPort: 9090 } ] }] }
    }
  }
}
`,
  'as JSON: added to': `{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": storefront, "namespace": "shop" },
  "spec": {
    "replicas": 3,
    "selector": { "matchLabels": { "app": storefront } },
    "template": {
      "metadata": { "labels": { "app": storefront } },
      "spec": { "containers": [{ "name": storefront, "image": ghcr.io/acme/storefront:3.0.0, ports: [ { containerPort: 9090 } ], env: [ { name: FEATURE_FLAGS, value: "on" }, { name: GREETING, value: "hello: world # not a comment" } ], resources: { requests: { cpu: 250m }, limits: { memory: 256Mi } } }] }
    }
  }
}
`,
  'as JSON: taken away': `{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": storefront, "namespace": "shop" },
  "spec": {
    "replicas": 3,
    "selector": { "matchLabels": { "app": storefront } },
    "template": {
      "metadata": { "labels": { "app": storefront } },
      "spec": { "containers": [{ "name": storefront, "image": ghcr.io/acme/storefront:3.0.0 }] }
    }
  }
}
`,
  'with a byte-order mark and a document marker: pasted': `\uFEFF---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
`,
  'with a byte-order mark and a document marker: values changed': `\uFEFF---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: shop
spec:
  replicas: 3
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0
          ports:
            - containerPort: 9090
`,
  'with a byte-order mark and a document marker: added to': `\uFEFF---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: shop
spec:
  replicas: 3
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0
          ports:
            - containerPort: 9090
          env:
            - name: FEATURE_FLAGS
              value: "on"
            - name: GREETING
              value: "hello: world # not a comment"
          resources:
            requests:
              cpu: 250m
            limits:
              memory: 256Mi
`,
  'with a byte-order mark and a document marker: taken away': `\uFEFF---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: shop
spec:
  replicas: 3
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
        - name: storefront
          image: ghcr.io/acme/storefront:3.0.0
`,
}
