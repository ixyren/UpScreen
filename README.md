# UpScreen v1.0.0

Aplicación moderna de captura de pantalla, edición rápida y upscaling con IA para Windows, construida con **Rust + Tauri v2**, **React 19**, **TypeScript** y **Tailwind CSS v4**.

## Características principales

- **Menú flotante minimalista** anclado en la parte inferior central de la pantalla (con panel desplegable hacia arriba) y soporte de bandeja del sistema.
- **3 modos de captura instantánea** con efecto de flash y sonido sutil de obturador:
  - **Recorte libre** (`Ctrl+Shift+S`): selección precisa con lupa de dimensiones y bloqueo **1:1 cuadrado manteniendo `Shift`**.
  - **Ventana** (`Ctrl+Shift+W`): detección automática de ventanas de Windows.
  - **Pantalla** (`Ctrl+Shift+F`): selector interactivo multi-monitor (o captura de todas las pantallas combinadas).
- **Editor integrado fluido**:
  - Viewport acelerado por GPU con zoom suave centrado en el cursor y paneo fluido.
  - Herramientas de **Recorte** (`Libre`, `16:9`, `4:3`, `1:1`), **Texto** editable en línea con fondo opcional, **Flechas**, **Rectángulos** y **Desenfoque** (incluso empezando desde fuera del borde de la imagen).
  - Historial `Ctrl+Z` / `Ctrl+Y`.
- **Exportación profesional**:
  - Bordes curvos y sombra suave en **PNG transparente** con vista previa en vivo.
  - Formatos `PNG`, `WebP`, `JPG` y `HEVC MP4` con detección automática de aceleración por hardware (**NVIDIA NVENC** / **AMD AMF** / **Intel QSV**).
- **Upscaling IA con Real-ESRGAN Vulkan** (descarga en 1 clic desde la app):
  - Escalado `2x`, `3x`, `4x`, `6x`, `8x`, `12x` y `16x`.
  - Modos **IA Nítida (SSAA)**, **TTA 8x**, **Directa** y **UI / Texto Puro**.
  - Limpieza inteligente de regiones de color plano para evitar bloques/artefactos de mosaico manteniendo el 100% del detalle real.
  - Comparador interactivo Antes / Después.

## Desarrollo y compilación

Requisitos: Node.js 20+, Rust (toolchain stable), WebView2 y Visual Studio C++ Build Tools (Windows).

```powershell
# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
npm run tauri dev

# Ejecutar tests de Rust
cd src-tauri
cargo test

# Compilar instalador Setup (.exe) y ejecutable standalone
npm run tauri build
```

Los binarios compilados se generan en:
- Instalador NSIS: `src-tauri/target/release/bundle/nsis/UpScreen_1.0.0_x64-setup.exe`
- Ejecutable portable: `src-tauri/target/release/upscreen.exe`
