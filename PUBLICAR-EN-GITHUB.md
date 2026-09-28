# Publicar Memoria CRM en GitHub Pages

Resultado: la app queda en una dirección tipo `https://TU-USUARIO.github.io/memoria-crm/`, con HTTPS. Así la puedes instalar en el móvil y usarla sin conexión.

**Qué se publica:** solo el código de la app. Tus clientes y notas **no** se suben nunca: viven en el navegador de cada dispositivo. Si otra persona abre la dirección, ve la app vacía, con sus propios datos.

**Antes de empezar:**
- Una cuenta gratuita de GitHub.
- El repositorio tiene que ser **público**: GitHub Pages con repositorio privado requiere un plan de pago.
- No hace falta subir los modelos de IA. La app los descarga la primera vez y los guarda en el navegador. Además, pesan más de lo que GitHub permite por archivo.

---

## Paso 1 · Crear el repositorio

1. Entra en [github.com](https://github.com) y pulsa **+** (arriba a la derecha) → **New repository**.
2. **Repository name:** `memoria-crm`. Este nombre aparece en la dirección final.
3. Elige **Public**.
4. No marques *Add a README* (la carpeta ya trae uno).
5. Pulsa **Create repository**.

## Paso 2 · Subir los archivos

### Opción A · Desde el navegador (sin instalar nada)

1. En la página del repositorio vacío, pulsa el enlace **uploading an existing file**.
2. Abre la carpeta `memoria-crm` en tu equipo, selecciona **todo su contenido** (Ctrl+A / Cmd+A) y arrástralo a la página. Chrome y Edge suben las subcarpetas (`css`, `js`, `vendor`…) tal cual.
   - Arrastra **el contenido**, no la carpeta. `index.html` tiene que quedar en la raíz del repositorio. Si arrastras la carpeta, la dirección termina en `/memoria-crm/memoria-crm/` y la raíz da error 404.
   - En Mac, Finder oculta `.nojekyll` y `.gitignore`. Pulsa Cmd+Shift+. para verlos. Si no se suben, la app funciona igual.
   - Ningún archivo pasa de 25 MB, que es el límite de la subida por navegador. El más grande es `vendor/ort/ort-wasm-simd-threaded.wasm`, con 14 MB.
   - Si ya descargaste los modelos dentro de `modelos/`, no los arrastres. Sube solo `modelos/LEEME.txt`.
3. Abajo, en *Commit changes*, escribe por ejemplo `Primera versión` y pulsa **Commit changes**.

### Opción B · Con git (terminal)

```bash
cd memoria-crm
git init -b main
git add .
git commit -m "Memoria CRM · primera versión"
git remote add origin https://github.com/TU-USUARIO/memoria-crm.git
git push -u origin main
```

El archivo `.gitignore` ya excluye los modelos de IA, así que `git add .` no los sube aunque los tengas en la carpeta.

## Paso 3 · Activar GitHub Pages

1. En el repositorio, ve a **Settings** → **Pages** (menú de la izquierda).
2. En **Build and deployment** → **Source**, elige **Deploy from a branch**.
3. En **Branch**, elige `main` y la carpeta `/ (root)`. Pulsa **Save**.
4. Espera de 1 a 3 minutos. Puedes ver el avance en la pestaña **Actions** (*pages build and deployment*).
5. Recarga *Settings → Pages*. Arriba aparece **Your site is live at `https://TU-USUARIO.github.io/memoria-crm/`**.

Opcional: en `README.md`, cambia `TU-USUARIO` por tu usuario para que el enlace funcione desde la portada del repositorio.

## Paso 4 · Primer uso (con Wi-Fi)

1. Abre la dirección.
2. Ve a **Ajustes / Settings** y espera a que los dos modelos digan *cargado / loaded*. Son unos 300 MB. En un móvil con poco espacio puedes desactivar el modelo de nombres (NER) y quedarte en unos 120 MB.
3. A partir de ahí la app y los modelos quedan guardados en el navegador y funciona en modo avión.

## Paso 5 · Instalar en el móvil

- **Android (Chrome):** abre la dirección → menú **⋮** → **Instalar app** o **Añadir a pantalla de inicio**.
- **iPhone (Safari):** abre la dirección → botón **Compartir** → **Añadir a pantalla de inicio**.

En iPhone, instálala siempre en la pantalla de inicio. Si solo la usas desde una pestaña de Safari, iOS puede borrar los datos del sitio tras unas semanas sin abrirlo.

En el ordenador, Chrome y Edge muestran un icono de instalar en la barra de direcciones.

---

## Actualizar la app más adelante

- **Por navegador:** en el repositorio pulsa **Add file → Upload files** y arrastra los archivos cambiados. Los que tengan el mismo nombre se reemplazan. Luego pulsa **Commit changes**.
- **Con git:** `git add . && git commit -m "Actualización" && git push`.

Tras 1 o 2 minutos, la próxima vez que abras la app con conexión se carga la versión nueva. Si no la ves, cierra la app del todo y ábrela otra vez. Tus datos no se tocan al actualizar.

## Tus datos entre dispositivos

Cada dispositivo y cada navegador guardan su propia base. Para pasar tus notas del PC al móvil, o para tener una copia de seguridad, usa **Ajustes → Descargar respaldo** en uno y **Restaurar respaldo** en el otro.

## Si algo falla

| Síntoma | Causa probable | Solución |
|---|---|---|
| Error 404 en la dirección | Pages aún no terminó, o `index.html` no está en la raíz | Espera 2 minutos. Revisa que en el repositorio se vea `index.html` junto a `css/` y `js/`, no dentro de otra carpeta. |
| La IA dice *no disponible* | Primera apertura sin conexión, o la descarga está desactivada | Abre la app con Wi-Fi y comprueba en Ajustes que la casilla de descarga esté marcada. Pulsa **Cargar IA ahora**. |
| No aparece la opción de instalar | La página no se abrió por `https://` o no terminó de cargar | Usa la dirección `github.io` completa y espera a que cargue. En iPhone, solo desde Safari. |
| Cambios subidos que no se ven | El navegador usa la copia guardada | Cierra la app del todo y ábrela con conexión. |

## Dominio propio (opcional)

En *Settings → Pages → Custom domain* puedes poner, por ejemplo, `crm.tudominio.com`. Tu proveedor de DNS te dirá qué registro CNAME apuntar a `TU-USUARIO.github.io`. La app no necesita ningún cambio, porque todas sus rutas son relativas.
