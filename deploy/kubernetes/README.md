# ZhiXu Kubernetes deployment

This example deploys one ZhiXu `StatefulSet` in the `zhixu` namespace. The container runs as UID/GID 10001 with a read-only root filesystem and mounts its persistent parent directory at `/data`, while the live state remains at `/data/state` so atomic restore can rename it.

```bash
kubectl apply -k deploy/kubernetes/overlays/example
kubectl -n zhixu rollout status statefulset/zhixu
kubectl -n zhixu port-forward svc/zhixu 5700:5700
```

Visit <http://127.0.0.1:5700>.

The committed overlay uses `anysoft/zhixu:1.0.0-rc.4` as an example. Before deployment, replace it with the exact image and digest from a verified release manifest. Keep `replicas: 1`; multiple replicas must never share the live SQLite data directory.

The base manifest gives `/data` a persistent `ReadWriteOnce` PVC. `/backup` is an ephemeral example volume: production deployments must replace it with durable storage and copy encrypted exports outside the cluster. Do not delete the data PVC during routine upgrades.

```bash
kubectl -n zhixu logs -f statefulset/zhixu
```
