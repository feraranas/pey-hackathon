# Cifrado en reposo

Qué queda en disco, qué está cifrado hoy y qué debe cifrar la VPS.

## Qué hay en disco

| Archivo | Contenido | Estado |
|---|---|---|
| `pey.sqlite` | Órdenes, cobros, webhooks, datos de cuenta, mensajes | Las columnas sensibles (`*_enc`: datos de cuenta, QR, cargas de trabajos, mensajes, webhooks) van con AES-256-GCM y `SESSION_ENCRYPTION_KEY`. Los IDs, estados, JIDs de clientes y sus nombres están en claro |
| `whatsapp.enc` | Sesión de Baileys (solo con ese transporte) | Cifrada con AES-256-GCM |
| `product-wa.db`, `merchant-wa.db` | Almacén de dispositivo de Whatsmeow: llaves de identidad, sesiones y claves de Signal | **En claro.** Whatsmeow no cifra el SQLite. Quien lea el archivo puede actuar como el dispositivo vinculado |
| Respaldos | `pey.sqlite`, `*.enc` | Los almacenes de Whatsmeow solo entran al respaldo cifrados (`merchant-wa.db.enc`); `verifyBackup` rechaza un respaldo con copias sin cifrar |
| PNG del QR de vinculación | Secreto de vinculación mientras es válido | Se escribe `0600` y se borra al vincular |

Los directorios de datos son `0700` y los archivos `0600`. Eso protege contra otros usuarios del sistema, no contra quien tenga el disco.

## Qué debe hacer la VPS

Mientras el almacén de Whatsmeow no se cifre por sí mismo, el volumen que lo contiene debe estar cifrado en reposo. Con LUKS sobre un volumen de bloque:

```bash
# Una sola vez, con el servicio detenido. La frase de paso no se guarda en el disco ni en el repositorio.
sudo cryptsetup luksFormat /dev/disk/by-id/<volumen>
sudo cryptsetup open /dev/disk/by-id/<volumen> pey-data
sudo mkfs.ext4 /dev/mapper/pey-data
sudo mkdir -p /srv/pey-data && sudo mount /dev/mapper/pey-data /srv/pey-data
sudo chown 1000:1000 /srv/pey-data && sudo chmod 700 /srv/pey-data
```

Usa ese directorio como volumen de datos en `compose.yaml` (`/srv/pey-data:/data`) en vez del volumen nombrado. Tras un reinicio hay que abrir el volumen con la frase de paso antes de arrancar los contenedores (`cryptsetup open` y `mount`); sin eso el servicio no arranca, que es el comportamiento deseado. Si prefieres desbloqueo automático con un archivo de llave, guárdalo en `tmpfs` o en un servicio de secretos, no en el mismo disco.

Comprueba el resultado y anota la fecha:

```bash
lsblk -f | grep -E 'crypto_LUKS|pey-data'
findmnt /srv/pey-data
sudo cryptsetup status pey-data
```

Esta guía no se ha ejecutado en la VPS: no hay acceso SSH desde la caja donde se desarrolló. Hasta que alguien anote ese resultado, el cifrado del almacén de Whatsmeow en la VPS cuenta como **pendiente**.

## Respaldos

`npm run backup -- DATA_DIR DESTINO_NUEVO` con `SESSION_ENCRYPTION_KEY` definida cifra cada almacén de Whatsmeow con AES-256-GCM antes de escribirlo y verifica el resultado. Sin la clave, el comando se niega. La clave se guarda aparte del respaldo y fuera de la VPS. Para restaurar: `npm run backup -- --restore RESPALDO DATA_DIR_VACÍO`, con el servicio detenido.

## Qué no cubre

- Un proceso en ejecución (la memoria contiene llaves) ni alguien con acceso root a la VPS encendida.
- Un volcado de memoria o un archivo de intercambio: desactiva los volcados (`ulimit -c 0`) y no uses swap sin cifrar.
- Un respaldo restaurado en una máquina equivocada: el almacén de dispositivo permite actuar como el teléfono vinculado.

## Si se filtra un almacén

Cierra la sesión del dispositivo desde el teléfono (WhatsApp → Dispositivos vinculados), borra el almacén comprometido y vuelve a vincular. Si el respaldo estaba cifrado y la clave no se filtró, no hace falta cerrar la sesión.
