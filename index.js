import express from "express";
import { config } from "dotenv";
import pg from "pg";
import multer from "multer";
import { fileURLToPath } from "url";
import path from "path";

// Cargar las variables de entorno
config();

// Obtener el nombre del archivo actual y el directorio del archivo
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Verificar que la URL de la base de datos está definida
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL no está definida en el archivo .env.");
  process.exit(1);
}

// Configuración de la conexión a la base de datos
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Cache en memoria para categorías
let categoriasCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60000; // 1 minuto

// Configuración de multer para manejar archivos PDF e imágenes, con límite de 100MB
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // Limitar a 100MB
}).fields([{ name: "archivo" }, { name: "imagen" }]);

// Aumentar el tiempo de espera para la carga de archivos grandes (10 minutos)
app.use((req, res, next) => {
  req.setTimeout(1000 * 60 * 10); // 10 minutos
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configurar carpeta pública para servir archivos estáticos
app.use(express.static(path.join(__dirname, "public")));

// Ruta principal para cargar el nuevo formulario de carga (index.html renombrado)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html")); // Aquí le dices que busque index.html dentro de 'public'
});

// Ruta principal para cargar el formulario de carga de libros
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "forma1.html"));
});

// Ruta para mostrar el archivo categoria.html
app.get("/categorias", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "categoria.html"));
});

// Ruta para cargar la página de la forma 2
app.get("/forma2", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "forma2.html"));
});

// Ruta para obtener las categorías únicas
app.get("/categorias/filtrar", async (req, res) => {
  try {
    const now = Date.now();

    // Si el caché es válido, lo usamos
    if (categoriasCache && now - cacheTimestamp < CACHE_DURATION) {
      return res.json(categoriasCache);
    }

    // Consulta optimizada usando DISTINCT sobre un resultado combinado.
    const result = await pool.query(`
      SELECT DISTINCT categoria FROM (
        SELECT categoria FROM libros
        UNION ALL
        SELECT categoria FROM libros1
      ) AS categorias
    `);

    categoriasCache = result.rows;
    cacheTimestamp = now;

    // Devolver el resultado y actualizar caché
    res.json(categoriasCache);
  } catch (error) {
    console.error("Error obteniendo categorías:", error);
    res.status(500).json({ error: "Error obteniendo categorías." });
  }
});

// Ruta para obtener los libros de una categoría específica o todos si no se selecciona categoría
app.get("/categorias/libros", async (req, res) => {
  const { categoria } = req.query;

  try {
    let query;
    let params;

    if (categoria) {
      // Utiliza UNION ALL para evitar la sobrecarga de eliminar duplicados
      query = `
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros' AS origen FROM libros WHERE categoria = $1)
        UNION ALL
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros1' AS origen FROM libros1 WHERE categoria = $1)
      `;
      params = [categoria];
    } else {
      // Obtener todos los libros, sin necesidad de filtrar por categoría
      query = `
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros' AS origen FROM libros)
        UNION ALL
        (SELECT id, nombre, categoria, imagen, tipo_imagen, 'libros1' AS origen FROM libros1)
      `;
      params = [];
    }

    const result = await pool.query(query, params);

    // Posteriormente procesamos las imágenes solo si es necesario (puedes decidir si lo haces en el cliente)
    const libros = result.rows.map((libro) => ({
      ...libro,
      imagen: libro.imagen
        ? `data:${libro.tipo_imagen};base64,${libro.imagen.toString("base64")}`
        : null, // Si no hay imagen, asignamos null
    }));

    // Solo en casos que sea necesario, por ejemplo, en entornos donde se necesiten imágenes
    res.json(libros);
  } catch (error) {
    console.error("Error obteniendo libros:", error);
    res.status(500).json({ error: "Error obteniendo libros." });
  }
});

// Ruta para subir libros con imagen y archivo (primer tipo de forma)
app.post("/subir-libro", upload, async (req, res) => {
  if (req.file && req.file.size > 100 * 1024 * 1024) {
    return res
      .status(400)
      .json({ error: "El archivo excede el tamaño permitido de 100MB." });
  }

  const { nombre, categoria } = req.body;
  const archivo = req.files["archivo"] && req.files["archivo"][0];
  const imagen = req.files["imagen"] && req.files["imagen"][0];

  if (!nombre || !categoria || !archivo || !imagen) {
    return res.status(400).json({ error: "Faltan campos requeridos." });
  }

  try {
    const query = `INSERT INTO libros (nombre, categoria, imagen, tipo_imagen, archivo, tipo_archivo) 
                   VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
    const result = await pool.query(query, [
      nombre,
      categoria,
      imagen.buffer,
      imagen.mimetype,
      archivo.buffer,
      archivo.mimetype,
    ]);

    res.status(201).json({
      message: "Libro subido exitosamente!",
      libroId: result.rows[0].id,
    });
  } catch (error) {
    console.error("Error al intentar subir el libro:", error.message);
    console.error("Detalles del error:", error);
    res.status(500).json({
      error: "Error subiendo el libro.",
      details: error.message || error,
    });
  }
});

// Ruta para subir libro con imagen y enlace (segundo tipo de forma)
app.post("/subir-libro-forma2", upload, async (req, res) => {
  const { nombre, categoria, enlace } = req.body;
  const imagen = req.files["imagen"] ? req.files["imagen"][0].buffer : null;
  const tipo_imagen = req.files["imagen"]
    ? req.files["imagen"][0].mimetype
    : null;

  if (!nombre || !categoria || !enlace) {
    return res.status(400).json({ error: "Faltan campos requeridos." });
  }

  try {
    // Eliminar la referencia a 'tipo_archivo' en la consulta
    const query = `INSERT INTO libros1 (nombre, categoria, imagen, tipo_imagen, archivo) 
                   VALUES ($1, $2, $3, $4, $5) RETURNING id`;
    const result = await pool.query(query, [
      nombre,
      categoria,
      imagen,
      tipo_imagen,
      enlace,
    ]);

    res.status(201).json({
      message: "Libro subido exitosamente con enlace y/o imagen!",
      libroId: result.rows[0].id,
    });
  } catch (error) {
    console.error("Error al intentar subir el libro:", error.message);
    console.error("Detalles del error:", error);
    res.status(500).json({
      error: "Error subiendo el libro.",
      details: error.message || error,
    });
  }
});
// Ruta para descargar el archivo de un libro
// Ruta para descargar libros desde libros1 (con enlace directo)
app.get("/descargar/libros1/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const resultLibros1 = await pool.query(
      "SELECT nombre, archivo FROM libros1 WHERE id = $1",
      [id]
    );

    if (resultLibros1.rows.length > 0) {
      const libro = resultLibros1.rows[0];
      // Redirigir al enlace directo
      return res.redirect(libro.archivo);
    }

    return res.status(404).send("Libro no encontrado en libros1.");
  } catch (error) {
    console.error("Error al descargar el libro de libros1:", error);
    res.status(500).send("Error al descargar el libro.");
  }
});

// Ruta optimizada para descargar el archivo de un libro
app.get("/descargar/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Ejecutar las dos consultas en paralelo
    const [resultLibros1, resultLibros] = await Promise.all([
      pool.query("SELECT nombre, archivo FROM libros1 WHERE id = $1", [id]),
      pool.query(
        "SELECT nombre, archivo, tipo_archivo FROM libros WHERE id = $1",
        [id]
      ),
    ]);

    // Si el libro está en libros1 (tiene enlace directo), redirigimos al enlace
    if (resultLibros1.rows.length > 0) {
      const libro = resultLibros1.rows[0];
      return res.redirect(libro.archivo); // Redirección al enlace del archivo
    }

    // Si no se encuentra en libros1, verificamos si está en libros (archivos físicos)
    if (resultLibros.rows.length === 0) {
      return res.status(404).send("Libro no encontrado.");
    }

    const libro = resultLibros.rows[0];

    // Si encontramos el libro en la tabla de libros, configuramos la respuesta para enviar el archivo
    res.setHeader("Content-Type", libro.tipo_archivo);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${libro.nombre}"`
    );

    // Enviar el archivo de manera más eficiente usando un flujo de lectura (streaming)
    // Para mantenerlo en memoria si el archivo no es tan grande, sino usar un stream para archivos grandes
    const buffer = Buffer.from(libro.archivo); // Considerar 'streaming' si el archivo es grande
    res.send(buffer); // Responde el archivo descargado al cliente
  } catch (error) {
    console.error("Error al descargar el libro:", error);
    res.status(500).send("Error al descargar el libro.");
  }
});
// Ruta para contar a un usuario basado en su IP
app.get("/contar-usuario", async (req, res) => {
  const ip_usuario = req.ip; // Obtener la IP del usuario

  try {
    // Verificar si la IP del usuario ya está almacenada
    const result = await pool.query("SELECT * FROM usuarios WHERE ip = $1", [
      ip_usuario,
    ]);

    if (result.rows.length === 0) {
      // Si el usuario no está en la base de datos, lo añadimos
      await pool.query("INSERT INTO usuarios (ip) VALUES ($1)", [ip_usuario]);

      // Incrementamos el contador
      await pool.query(
        "UPDATE contador SET visitas = visitas + 1 WHERE id = 1"
      );
      return res.json({ message: "Nuevo visitante registrado" });
    } else {
      return res.json({ message: "El visitante ya fue contado" });
    }
  } catch (error) {
    console.error("Error al contar el usuario:", error);
    return res
      .status(500)
      .json({ error: "Hubo un error al registrar al usuario" });
  }
});
app.get("/obtener-contador", async (req, res) => {
  try {
    // Obtener el número total de visitantes únicos desde la tabla "contador"
    const result = await pool.query(
      "SELECT visitas FROM contador WHERE id = 1"
    );
    const visitas = result.rows[0].visitas;
    return res.status(200).json({ count: visitas });
  } catch (error) {
    console.error("Error al obtener el contador:", error);
    return res
      .status(500)
      .json({ error: "Error al obtener contador de visitas" });
  }
});

// Puerto de escucha
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor en puerto ${port}`);
});
