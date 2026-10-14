- **Argo CD's and CloudNativePG's plugins draw pages of their own**, from code that comes with
  Lumovi and runs in the same sealed box, reading only what each file says, as you. Argo CD: an
  **Overview** of what needs a look; every Application in one table, filtered and searched, with
  **Sync** and **Refresh** for the ones selected; and a tab on an Application with where its sync
  is, its resources down to their pods, its problems and **Roll back**. Its **Sync…** has every
  option Argo CD's own has, says in red what a sync would harm, and is busy while one runs, with
  **Terminate sync**. Its **Sync…**, **Refresh…** and **Delete…** are changes you confirm in
  Lumovi's own dialog, shown as the cluster would make them. Besides Argo CD's own kinds it reads
  ReplicaSets and Pods, never what they run, and the warning events of those that aren't well, each
  message cut where it could carry what only you may read. CloudNativePG: an **Overview** of every
  PostgreSQL cluster with its instances, backups, schedules and poolers, and a **Backup health**
  page; its **Back up now…** is confirmed the same way. A resource's row opens Lumovi's own list at
  that object.
