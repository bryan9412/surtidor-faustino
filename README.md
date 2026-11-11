# Surtidor Faustino

Aplicación Android **sin conexión** para el expendedor de combustible del Hospital Provincial Clínico Quirúrgico Docente «Faustino Pérez Hernández».
Lee el **código QR** de cada cupón de combustible y dice, sin internet, si es **válido**, si **ya se canjeó**, si está **fuera de semana** o si es **falso**.

Los cupones y los canjes **nunca salen por internet**: la parte web de la aplicación no tiene acceso a la red (su política de seguridad lo impide) y todo funciona sin conexión. Permisos: la **cámara** (para leer el QR) e **Internet**, que solo usa la parte nativa para preguntar si hay una versión nueva y descargarla.

## Cómo se usa

1. La Dirección descarga en el Sistema de Gobierno Hospitalario (Combustible → **Expendedor**) el **archivo de cupones activos** de la semana y se lo manda al expendedor (WhatsApp, Bluetooth, USB).
2. En la aplicación: **Cargar cupones** → elige el archivo. La primera vez muestra la **huella de la llave** del hospital: se confirma con la Dirección y el teléfono queda *emparejado* (solo aceptará archivos firmados con esa llave).
3. **Escanear cupón** → la aplicación dice si vale. Si el combustible se entrega: **Ya entregué el combustible**. Los litros son siempre los del cupón.
4. Al terminar: **Canjes → Enviar a la Dirección** (comparte el archivo de canjes). La Dirección lo carga en el sistema y se cierra el ciclo.

Si la cámara falla: **Leer el QR de una foto** o **Teclear folio y código** (van impresos en el cupón).

**Cargar el archivo desde WhatsApp:** al tocar *Cargar cupones*, el selector se abre en la carpeta donde WhatsApp guarda los documentos. También se puede tocar el archivo en WhatsApp y elegir *Surtidor Faustino* (o «Compartir» → *Surtidor Faustino*): se carga directamente.

**Actualizaciones:** al abrir la aplicación con internet, avisa si hay una versión nueva; *Ajustes → Buscar actualización* lo comprueba a mano. *Actualizar* descarga la APK nueva y abre el instalador de Android; los cupones y canjes se conservan. Esto necesita que el repositorio sea **público** (con un repositorio privado la comprobación no puede consultar GitHub y se omite sin molestar).

## Seguridad (en corto)

- El QR lleva `SGHC1:<folio>:<código>`; el secreto con que se calculan los códigos **nunca** está en la aplicación ni en el archivo.
- El archivo de cupones va **firmado** (Ed25519) por el sistema del hospital; la aplicación comprueba la firma y rechaza archivos alterados o de otro origen.
- Cada canje lleva una **prueba** (HMAC-SHA256 con el código del cupón): solo quien recibió el cupón en su archivo puede producirla, así que no se pueden inventar canjes.
- El archivo de cupones no lleva carné ni pacientes: solo folio, código, chofer, matrícula, combustible, litros y días.

## Para quien mantiene el proyecto

- `app/src/main/assets/` — la aplicación (HTML/JS/CSS) que se empaqueta dentro de la APK. `nucleo.js` es la lógica sin pantalla.
- `prueba/prueba.js` — pruebas del núcleo con Node (`node prueba/prueba.js`). Usan un archivo de cupones **real** generado por el sistema (datos ficticios), así que comprueban que la firma hecha con libsodium (PHP) se verifica aquí.
- `app/src/main/java/.../MainActivity.java` — el envoltorio Android (cámara, selector de archivos, enviar y guardar).
- `.github/workflows/apk.yml` — compila la APK con GitHub Actions (no se instala nada en ninguna PC) y la publica en **Releases** como `Surtidor-Faustino.apk`. Si las pruebas fallan, no se publica.
- La APK se firma con una llave guardada en secretos del repositorio (`KS_B64`, `KS_PASS`). Con la misma llave, una versión nueva se instala encima de la anterior sin perder los canjes.

Librerías incluidas (sin conexión): [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0) y [TweetNaCl.js](https://github.com/dchest/tweetnacl-js) (dominio público).

## Descargar

Ver **Releases** → `Surtidor-Faustino.apk`. En el teléfono hay que permitir instalar aplicaciones de esta fuente la primera vez.
