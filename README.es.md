<!-- Selector de idioma -->
**🌐 Idioma:** [English](./README.md) · Español · [Português](./README.pt.md)

# Reporte de Amazon WorkSpaces sin uso (CDK)

Detecta y reporta los Amazon WorkSpaces que no se han utilizado durante N días,
luego envía un resumen por correo y archiva un CSV en S3. Implementación
modernizada construida con **AWS CDK v2 + TypeScript**, **AWS Lambda Node.js 24**
sobre **Graviton (arm64)**, **AWS SDK v3**, **Amazon EventBridge Scheduler**,
alarmas operativas con cola de mensajes fallidos (DLQ), y valores de seguridad
predeterminados validados con **cdk-nag**.

> [!NOTE]
> Este proyecto fue modernizado desde una plantilla de CloudFormation de un solo
> archivo hacia una aplicación CDK v2. Despliega usando la aplicación CDK que se
> describe a continuación.

## Tabla de contenidos

- [Arquitectura](#arquitectura)
- [Cómo funciona](#cómo-funciona)
- [Seguridad por defecto](#seguridad-por-defecto)
- [Requisitos previos](#requisitos-previos)
- [Configuración](#configuración)
- [Vista FinOps](#vista-finops)
- [Despliegue](#despliegue)
- [Pruebas](#pruebas)
- [Limpieza](#limpieza)
- [Costos](#costos)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Hoja de ruta](#hoja-de-ruta)
- [Contribuir y seguridad](#contribuir-y-seguridad)
- [Licencia](#licencia)

## Arquitectura

![Diagrama de arquitectura de la solución Report Unused WorkSpaces](./images/report-unused-workspaces-architecture.png)

> El archivo editable es [`images/report-unused-workspaces-architecture.drawio`](./images/report-unused-workspaces-architecture.drawio)
> (ábrelo con [draw.io](https://draw.io) / diagrams.net). Vuelve a exportar el PNG después de editarlo.

| Componente | Servicio | Propósito |
| --- | --- | --- |
| Programador | Amazon EventBridge Scheduler | Activa la función cada `executionRateDays` días |
| Cómputo | AWS Lambda (Node.js 24, arm64) | Consulta los WorkSpaces y arma el reporte |
| Notificación | Amazon SNS (cifrado con KMS) | Envía el resumen por correo a los suscriptores |
| Almacenamiento | Amazon S3 (privado, con versiones) | Archiva el reporte CSV en `reports/` |
| Resiliencia | Amazon SQS (cola de mensajes fallidos) | Captura las invocaciones programadas fallidas |
| Alertas | Amazon CloudWatch Alarms | Notifica errores/throttling de Lambda y mensajes en la DLQ |
| Observabilidad | Amazon CloudWatch Logs + AWS X-Ray | Registra y traza cada ejecución |

## Cómo funciona

1. **EventBridge Scheduler** invoca la función Lambda con una cadencia configurable.
2. La **Lambda** llama a `workspaces:DescribeWorkspacesConnectionStatus` (con
   paginación) y calcula, por cada workspace, los días transcurridos desde la
   última conexión del usuario.
3. Los workspaces se dividen en dos grupos: *sin uso durante ≥ el umbral de días*
   y *nunca conectados* (sin `LastKnownUserConnectionTimestamp`).
4. Los workspaces marcados se enriquecen con `workspaces:DescribeWorkspaces`
   añadiendo el usuario, el directorio, el bundle, el tipo de cómputo y el modo de
   ejecución (AlwaysOn vs. AutoStop), de modo que el reporte sea accionable y
   resalte oportunidades de ahorro.
5. Una **vista FinOps** estima el costo de ejecución mensual de cada workspace
   inactivo y el ahorro realizable al **terminarlo**, desglosado por modo de
   ejecución. Los precios provienen de una tabla configurable o, de forma
   opcional, en vivo desde la **AWS Price List API**. Consulta
   [Vista FinOps](#vista-finops) para conocer el modelo de costos.
6. La función escribe un CSV con marca de tiempo en `s3://<bucket>/reports/` (los
   valores se escapan según RFC 4180 y se protegen contra la inyección de fórmulas
   de hoja de cálculo) y publica un resumen legible en **SNS**.
7. **SNS** entrega el reporte a la dirección de correo suscrita.
8. Si una invocación programada falla tras los reintentos, el evento llega a una
   **cola de mensajes fallidos (DLQ) de SQS**, y las **alarmas de CloudWatch**
   publican en el mismo tema de SNS ante errores/throttling de Lambda o actividad
   en la DLQ.
9. **CloudWatch Logs** y **X-Ray** capturan el detalle de la ejecución para el
   diagnóstico.

## Seguridad por defecto

La solución está diseñada en torno al menor privilegio y a las mejores prácticas
de seguridad de AWS:

- **S3** — `BlockPublicAccess.BLOCK_ALL`, `BucketOwnerEnforced` (ACLs
  deshabilitadas), SSL obligatorio mediante política de bucket, versionado
  habilitado, cifrado administrado por S3, reglas de ciclo de vida para expirar
  los reportes tras `reportRetentionDays`, registro de acceso al servidor en un
  bucket de logs dedicado y `RETAIN` al eliminar el stack.
- **SNS** — cifrado en reposo con la clave administrada por AWS `alias/aws/sns`.
- **Lambda** — arm64 (Graviton), Node.js 24, AWS X-Ray activo, configuración por
  variables de entorno y grupo de logs dedicado con retención de un mes.
- **IAM** — limitado estrictamente a lo que usa el código:
  - `workspaces:DescribeWorkspacesConnectionStatus` y
    `workspaces:DescribeWorkspaces` sobre `*` (estas API **no** admiten permisos a
    nivel de recurso).
  - `pricing:GetProducts` sobre `*` (solo cuando la Price List API está habilitada;
    esta API no admite permisos a nivel de recurso).
  - `s3:PutObject` solo sobre el prefijo `reports/*`.
  - `sns:Publish` solo sobre el ARN del tema creado.
- **Resiliencia** — el destino de EventBridge Scheduler tiene una cola de mensajes
  fallidos de SQS (con SSE, SSL obligatorio y retención de 14 días) para que las
  invocaciones fallidas nunca se pierdan; las alarmas de CloudWatch sobre `Errors`
  y `Throttles` de Lambda y la profundidad de la DLQ publican en el tema de SNS del
  reporte.
- **cdk-nag** — el paquete `AwsSolutionsChecks` se ejecuta en cada `cdk synth` y
  detiene la compilación ante cualquier hallazgo.

## Requisitos previos

- **Node.js 20+** y npm
- Una cuenta de AWS **inicializada para CDK v2** (`npx cdk bootstrap`)
- Credenciales configuradas para la cuenta/región de destino
- Una **dirección de correo que controles** (debes confirmar la suscripción a SNS)

## Configuración

Define los valores en `cdk.json` dentro de `context.reportUnusedWorkspaces`:

```json
{
  "reportUnusedWorkspaces": {
    "emailAddress": "tu@ejemplo.com",
    "executionRateDays": 7,
    "unusedDaysThreshold": 30,
    "reportRetentionDays": 365,
    "usePricingApi": false,
    "prices": {
      "STANDARD": { "alwaysOn": 35, "autoStopBase": 9.75 }
    }
  }
}
```

| Parámetro | Descripción | Valor por defecto | Rango |
| --- | --- | --- | --- |
| `emailAddress` | Destinatario del reporte (suscripción a SNS) | — (obligatorio) | correo válido |
| `executionRateDays` | Frecuencia de ejecución del reporte, en días | `7` | `3`–`30` |
| `unusedDaysThreshold` | Umbral de inactividad para marcar un workspace | `30` | `7`–`90` |
| `reportRetentionDays` | Tiempo de conservación de los CSV en S3 | `365` | ≥ `1` |
| `usePricingApi` | Resuelve precios de lista en vivo desde la AWS Price List API (agrega `pricing:GetProducts`) | `false` | booleano |
| `prices` | Sobrescrituras de precio mensual por tipo de cómputo para la vista FinOps | estimaciones integradas | objeto |

Como alternativa, proporciona el correo con la variable de entorno `REPORT_EMAIL`
y sobrescribe los valores por defecto con `--context`:

```sh
REPORT_EMAIL=tu@ejemplo.com npx cdk deploy \
  -c reportUnusedWorkspaces.executionRateDays=7 \
  -c reportUnusedWorkspaces.unusedDaysThreshold=30
```

### Variables de entorno (Lambda)

Normalmente la aplicación CDK las define por ti, pero también pueden suministrarse
directamente:

| Variable | Descripción |
| --- | --- |
| `USE_PRICING_API` | Cuando es `true`, obtiene los precios de lista de WorkSpaces en vivo mediante la Price List API. |
| `WORKSPACE_PRICES_JSON` | Tabla de precios en JSON que se fusiona sobre los valores predeterminados integrados, p. ej. `{"STANDARD":{"alwaysOn":35,"autoStopBase":9.75}}`. |
| `PRICING_REGION_CODE` | Región cuyos precios se obtienen (por defecto, la Región de la función). |

## Vista FinOps

El reporte incluye una vista de costos para ayudar a dimensionar la oportunidad de
ahorro. Traza una línea deliberada entre dos cifras diferentes:

- **Costo de ejecución actual** — lo que los workspaces inactivos están costando
  *ahora*. Un workspace `ALWAYS_ON` inactivo factura su tarifa mensual fija
  completa; un workspace `AUTO_STOP` inactivo ya factura cerca de su tarifa base
  mensual fija, por lo que se modela como esa base (no como uso completo).
- **Ahorro realizable al terminar** — lo que deja de facturarse si el workspace se
  **termina**, que es la única palanca sobre la que actúa este reporte. Se desglosa
  por modo de ejecución, y **los workspaces `ALWAYS_ON` inactivos se marcan como la
  prioridad** (el ahorro más grande y certero, y una probable brecha de cobertura).

> [!NOTE]
> Este reporte **no** cambia los modos de facturación. Convertir entre `ALWAYS_ON`
> y `AUTO_STOP` según el uso real es tarea de
> [Cost Optimizer for Amazon WorkSpaces](https://docs.aws.amazon.com/solutions/latest/cost-optimizer-for-workspaces/overview.html)
> (WCO); ambos son complementarios.

Las cifras son **estimaciones a precio de lista**. Para montos autorizados
(incluidos descuentos EDP/PPA y el uso real por hora de `AUTO_STOP`), usa **AWS
Cost Explorer**. Los precios se resuelven en capas, de la más autorizada a la
menos: Price List API (si está habilitada) → sobrescritura de
`prices`/`WORKSPACE_PRICES_JSON` → valores predeterminados integrados. Los fallos
de precios nunca interrumpen una ejecución; el reporte recurre a la siguiente capa.

## Despliegue

```sh
npm install
npm test           # ejecuta las pruebas de aserción de CDK
npm run synth      # cdk synth (ejecuta cdk-nag)
npm run deploy     # cdk deploy
```

Después del despliegue, **revisa tu bandeja de entrada y confirma la suscripción a
SNS** para empezar a recibir los reportes.

## Pruebas

El repositorio incluye dos suites de Jest:

- **Pruebas de aserción del stack** que validan la plantilla sintetizada
  (endurecimiento de S3, cifrado de SNS, runtime/arquitectura, conexión del
  programador y la DLQ, alarmas, y alcance de IAM).
- **Pruebas unitarias del handler** que cubren la lógica de negocio de forma
  aislada con `aws-sdk-client-mock` (clasificación y cálculo de días, escape CSV
  según RFC 4180 y protección contra inyección de fórmulas, paginación,
  enriquecimiento de metadatos y el resumen del correo).

```sh
npm test               # ejecuta ambas suites
npm run test:coverage  # ejecuta con reporte de cobertura
```

## Limpieza

```sh
npm run destroy    # cdk destroy
```

> [!IMPORTANT]
> El bucket de reportes y su bucket de logs de acceso usan una política de
> eliminación `RETAIN`, por lo que **no** se eliminan junto con el stack. Vacíalos
> y elimínalos manualmente si ya no necesitas los reportes archivados.

## Costos

Ejecutar esta solución genera los cargos estándar de AWS por los recursos que crea
(invocaciones de Lambda, almacenamiento en S3, notificaciones de SNS, CloudWatch
Logs y trazas de X-Ray). Para una flota pequeña de WorkSpaces con una programación
semanal, el costo suele ser insignificante, pero eres responsable de los cargos en
tu cuenta.

## Estructura del proyecto

```
.
├── .github/workflows/ci.yml            # Lint, pruebas, synth + cdk-nag en los PR
├── bin/app.ts                          # Punto de entrada de la app CDK
├── lib/report-unused-workspaces-stack.ts
├── src/handler/index.ts                # Lambda (Node.js 24, AWS SDK v3)
├── src/handler/pricing.ts              # Integración con AWS Price List API (FinOps)
├── test/report-unused-workspaces-stack.test.ts  # Pruebas de aserción de CDK
├── test/handler.test.ts                # Pruebas unitarias de la Lambda
├── test/pricing.test.ts                # Pruebas unitarias de la Price List API
├── cdk.json
└── package.json
```

## Hoja de ruta

Lanzado recientemente:

- ✅ **Endurecimiento operativo** — DLQ de Lambda en el destino del programador,
  más alarmas de CloudWatch de error/throttling/DLQ.
- ✅ **Reportes más ricos** — enriquecidos con usuario, directorio, bundle, tipo de
  cómputo y modo de ejecución AlwaysOn vs. AutoStop para dar contexto de ahorro de
  costos.
- ✅ **Vista FinOps** — estima el costo de ejecución de los workspaces inactivos y
  el ahorro realizable al terminarlos, desglosado por modo de ejecución, con
  precios en vivo opcionales desde la AWS Price List API.
- ✅ **CI** — GitHub Actions que ejecuta lint, pruebas, synth y cdk-nag, con
  Dependabot manteniendo al día el AWS SDK y CDK.

Ideas para llevar la solución aún más lejos:

- Cobertura **multicuenta / multirregión** mediante CloudFormation StackSets o
  personalizaciones de Control Tower, consolidando los resultados de forma central.
- **Showback por etiqueta** — agrupa el desperdicio por propietario/equipo/centro
  de costos y, de forma opcional, envía correos por propietario.
- **Métricas de tendencia** — emite una métrica personalizada de CloudWatch (p. ej.
  el desperdicio mensual estimado) para paneles y alarmas a lo largo del tiempo.
- **Auto-remediación** con un flujo opcional de Step Functions (reporte →
  aprobación humana → terminar), manteniendo la terminación estrictamente con
  intervención humana.
- **Reconciliación de valores reales** mediante Cost Explorer / CUR para comparar
  las estimaciones a precio de lista con el gasto real.
- **Modo data lake** que escribe Parquet particionado por fecha para
  Athena/QuickSight.
- **Destinos conectables** (SES en HTML, Slack, Teams, bus de EventBridge).
- **CD** con despliegues basados en OIDC y análisis de seguridad.

## Contribuir y seguridad

Consulta [CONTRIBUTING](CONTRIBUTING.md) para conocer las pautas y cómo reportar
problemas de seguridad.

## Licencia

Esta biblioteca está licenciada bajo la licencia MIT-0. Consulta el archivo
[LICENSE](LICENSE).
