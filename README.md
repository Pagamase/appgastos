# App Gastos Fluge

Aplicacion web para registrar gastos de viajes de trabajo, conectada de forma fija a Google Sheets.

## Funciones
- Crear y gestionar viajes con destino, fechas y presupuesto.
- Registrar gastos por viaje con categoria, importe, medio de pago y notas.
- Marcar gastos facturables.
- Ver resumen de gasto, presupuesto, saldo y desglose por categoria.
- Buscar y filtrar gastos.
- Eliminar gastos y viajes.
- Exportar CSV del viaje activo.
- Guardado local automatico y sincronizacion en Google Sheets.
- Al sincronizar, cada gasto se escribe en su hoja del viaje en filas (A:G desde fila 3).

## Archivos principales
- `index.html`: interfaz.
- `styles.css`: estilos.
- `app.js`: logica de app y sincronizacion.
- `backend/google-apps-script/Code.gs`: backend para Google Sheets (Apps Script).
- `scripts/push-gas.ps1`: push automatico de Apps Script con clasp.
- `scripts/pull-gas.ps1`: pull desde Apps Script con clasp.

## Uso local rapido
1. Abre `index.html` en el navegador.
2. Crea un viaje y registra gastos.

## Configurar nube con Google Sheets
1. Crea o abre tu Google Sheet.
2. En el Sheet: `Extensions > Apps Script`.
3. Copia el contenido de `backend/google-apps-script/Code.gs` y pegalo en `Code.gs`.
4. En el script, revisa estas constantes:
   - `TEMPLATE_SHEET_NAME`: nombre exacto de tu hoja base (por defecto `Gastos_Base`).
   - `TEMPLATE_DESTINATION_TOKEN`: texto del nombre de plantilla que se reemplaza por el destino (por defecto `Base`).
   - `SHARED_TOKEN`: token opcional de seguridad.
5. (Opcional) En tu plantilla puedes usar placeholders:
   - `{{TRIP_ID}}`, `{{TRIP_NAME}}`, `{{DESTINATION}}`, `{{START_DATE}}`, `{{END_DATE}}`, `{{BUDGET}}`.
   - Al crear un viaje nuevo, el script copia la plantilla y reemplaza esos valores.
6. Guarda y despliega:
   - `Deploy > New deployment`
   - Tipo: `Web app`
   - `Execute as`: `Me`
   - `Who has access`: `Anyone`
7. Copia la URL terminada en `/exec`.
8. En `app.js`, actualiza:
   - `FIXED_CLOUD_ENDPOINT` con tu URL `/exec`.
   - `FIXED_CLOUD_TOKEN` si usas token.

## Flujo de sincronizacion
- Si la nube ya tiene datos, la app carga esos datos.
- Si la nube esta vacia pero local tiene datos, sube la copia local.
- Cada cambio se guarda en local y se sincroniza automaticamente.
- Puedes usar `Sincronizar ahora` manualmente.
- Cada viaje nuevo crea una pestana nueva en el Sheet, copiando `TEMPLATE_SHEET_NAME`.
- El nombre de la nueva pestana se genera reemplazando `Base` por el `Destino` del viaje (ejemplo: `Gastos_Madrid`).
- Al crear la pestana, se escribe en `A1:G1`:
  - `Viaje a "DESTINO" entre las fechas "DD/MM/YYYY" y "DD/MM/YYYY"`.
- El estado de la app ya no usa hoja visible `FlugeData`; se guarda en `Script Properties` del Apps Script.
- Gastos en hoja:
  - Fila inicial: `3`
  - `A`: Fecha
  - `B`: Categoria
  - `C`: Descripcion
  - `D`: Importe
  - `E`: Medio de pago
  - `F`: Notas
  - `G`: URL de foto (si existe)
- Las fotos se guardan en Google Drive dentro de la carpeta `_FlugeGastosFotos`.

## Recomendacion para usar en movil y PC
- Publica esta carpeta como web estatica (por ejemplo GitHub Pages o Netlify) y usa la misma URL en ambos dispositivos.
- Mantener la app solo como archivo local puede dar problemas de permisos/CORS en algunos navegadores.

## Push automatico de Code.gs (sin copiar/pegar)
1. Primera vez: enlaza este proyecto con tu Apps Script:
   - `.\scripts\push-gas.ps1 -ScriptId TU_SCRIPT_ID`
2. A partir de ahi, cada cambio:
   - `.\scripts\push-gas.ps1`
3. Si quieres traer cambios remotos:
   - `.\scripts\pull-gas.ps1`

Notas:
- El `rootDir` de clasp queda fijado a `backend/google-apps-script`.
- Esto evita el problema de escanear carpetas externas y solo sube el backend de esta app.
